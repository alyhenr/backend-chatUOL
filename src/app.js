import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
import joi from "joi";
import dayjs from "dayjs";
import { Buffer } from 'node:buffer';

// Config --------------------
const app = express();
app.use(express.json());

dotenv.config();
const mongoClient = new MongoClient(process.env.DATABASE_URL);
const dbName = "chatUOL";
const collections = {
    participants: "participants",
    messages: "messages",
}

const loginSchema = joi.object({
    name: joi.string().required(),
});

const messageSchema = joi.object({
    from: joi.string().required(),
    to: joi.string().required(),
    text: joi.string().required(),
    type: joi.string().required().valid('message', 'private_message'),
});

const joiValidation = (schema, obj) => schema.validate(obj, { abortEarly: false });

// --------------------------
async function main() {
    await mongoClient.connect();
    console.log("Success connecting to db.");
    const db = mongoClient.db(dbName);
    const messagesColl = db.collection("messages");
    const participantsColl = db.collection("participants");

    // Remove inactive user:
    setInterval(async () => {
        const query = { lastStatus: { $lt: Date.now() - 10 * 1000 } };
        try {
            const inactiveUsers = await participantsColl.find(query).toArray();
            if (inactiveUsers.length) {
                participantsColl.deleteMany(query)
                    .then(() => {
                        messagesColl.insertMany(inactiveUsers.map(data => ({
                            from: data.name,
                            to: "Todos",
                            text: "sai da sala",
                            type: "status",
                            time: dayjs().format('HH:mm:ss'),
                        }))
                        );
                    })
                    .catch((err) => { console.log(err); });
            }
        } catch (err) {
            console.log("No users removed", err);
        }
    }, 15000);


    // Endpoints:
    app.post("/participants", async (req, res) => {
        const { name } = req.body;
        const validation = joiValidation(loginSchema, { name });
        if (validation.error) {
            const errors = validation.error.details.map((detail) => detail.message);
            return res.status(422).send(errors);
        }

        try {
            await participantsColl.insertOne({ name, lastStatus: Date.now() });
            await messagesColl.insertOne({
                from: name,
                to: "Todos",
                text: "entra na sala",
                type: "status",
                time: dayjs().format("HH:mm:ss"),
            });
            res.status(201).send({ name: name, lastStatus: Date.now() });
        } catch (e) {
            res.sendStatus(500);
        }
    });

    app.get("/participants", (req, res) => {
        participantsColl.find().toArray()
            .then(data => { res.status(200).send(data); })
            .catch(() => { res.sendStatus(500); });
    });

    app.post("/messages", async (req, res) => {
        const { to, text, type } = req.body;
        const { user } = req.headers;
        const user_decoded = Buffer.from(user, 'latin1').toString();

        const isOn = await participantsColl.findOne({ name: user_decoded });
        if (!isOn) return res.sendStatus(401);

        const messageData = {
            from: user_decoded,
            to,
            text,
            type,
        };

        const validation = joiValidation(messageSchema, messageData);

        if (validation.error) {
            const errors = validation.error.details.map((detail) => detail.message);
            return res.status(422).send(errors);
        }

        try {
            await messagesColl.insertOne({ ...messageData, time: dayjs().format("HH:mm:ss"), });
            res.status(201).send(messageData);
        } catch (e) {
            res.sendStatus(500);
        }
    });

    app.get("/messages", async (req, res) => {
        const { limit } = req.query;
        const { user } = req.headers;
        const user_decoded = Buffer.from(user, 'latin1').toString();
        if (limit && (limit <= 0 || limit !== parseInt(limit).toString()))
            return res.status(422).send("'limit' deve ser um número inteiro maior que zero!");

        try {
            const messages = await messagesColl.find(
                { $or: [{ from: user_decoded }, { to: user_decoded }, { to: "Todos" }] }
            ).toArray();
            if (limit && messages.length > limit) {
                return res.status(200).send(messages.slice(-limit));
            }

            res.status(200).send(messages);
        } catch (err) {
            console.log(err);
            res.sendStatus(500);
        }
    });

    app.post("/status", async (req, res) => {
        const { user } = req.headers;
        if (!user) return res.sendStatus(404);

        const user_decoded = Buffer.from(user, 'latin1').toString();
        const answer = await participantsColl.findOne({ name: user_decoded });

        if (answer) {
            participantsColl
                .updateOne(
                    { name: user_decoded },
                    { $set: { name: user_decoded, lastStatus: Date.now(), } }
                );
            res.sendStatus(200);
        } else {
            res.status(404).send("Usuário não encontrado.");
        }
    });
}

const PORT = 5000;
app.listen(PORT, () => console.log(`Connected, port: ${PORT}`));

main();
