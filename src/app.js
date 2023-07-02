import { MongoClient, ObjectId } from "mongodb";
import { Buffer } from 'node:buffer';
import { stripHtml } from "string-strip-html";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import joi from "joi";
import dayjs from "dayjs";

// Config --------------------
const app = express();
app.use(cors());
app.use(express.json());

dotenv.config();
const mongoClient = new MongoClient(process.env.DATABASE_URL);
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

// Sanitize data:
const sanitize = data => {
    return stripHtml(data).result.trim();
};

// --------------------------
async function main() {
    await mongoClient.connect();
    console.log("Success connecting to db.");
    const db = mongoClient.db();
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
    app.post("/participants", (req, res) => {
        let { name } = req.body;
        const validation = joiValidation(loginSchema, { name });
        if (validation.error) {
            const errors = validation.error.details.map((detail) => detail.message);
            return res.status(422).send(errors);
        } else { name = sanitize(name); }

        try {
            participantsColl.findOne({ name })
                .then(async data => {
                    if (data) return res.status(409).send("Usuário já está na sala.");
                    await participantsColl.insertOne({ name, lastStatus: Date.now() });
                    await messagesColl.insertOne({
                        from: name,
                        to: "Todos",
                        text: "entra na sala",
                        type: "status",
                        time: dayjs().format("HH:mm:ss"),
                    });
                    res.status(201).send({ name, lastStatus: Date.now() });
                })
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
        const { user } = req.headers;
        if (!user ||
            !await participantsColl.findOne({ name: user_decoded }))
            return res.sendStatus(422);

        const { to, type, text } = req.body;
        const user_decoded = Buffer.from(user, 'latin1').toString();
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
            await messagesColl.insertOne({ ...messageData, text: sanitize(text), time: dayjs().format("HH:mm:ss"), });
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
        if (!user) return res.sendStatus(422);

        const user_decoded = Buffer.from(user, 'latin1').toString();

        if (await participantsColl.findOne({ name: user_decoded })) {
            participantsColl
                .updateOne(
                    { name: user_decoded },
                    { $set: { name: user_decoded, lastStatus: Date.now(), } }
                );
            res.sendStatus(200);
        } else {
            res.status(422).send("Usuário não encontrado.");
        }
    });

    app.delete("/messages/:id", async (req, res) => {
        const { id } = req.params;
        const { user } = req.headers;
        const message = await messagesColl.findOne({ _id: new ObjectId(id) });

        if (!message) return res.sendStatus(404);
        if (user != message['from']) return res.sendStatus(401);

        try {
            await messagesColl.deleteOne({ _id: new ObjectId(id) });
            res.status(200).send(message);
        } catch (err) {
            console.log(err);
            res.sendStatus(500);
        }
    });

    app.put("/messages/:id", async (req, res) => {
        const { id } = req.params;
        const { user } = req.headers;
        const { to, type } = req.body;
        let { text } = req.body;

        const user_decoded = Buffer.from(user, 'latin1').toString();
        const messageOwner = await participantsColl.findOne({ name: user_decoded });
        if (!messageOwner || messageOwner['name'] !== user_decoded)
            return res.sendStatus(401);

        const validation = joiValidation(messageSchema,
            { from: user_decoded, to, text, type });
        if (validation.error) {
            const errors = validation.error.details.map((detail) => detail.message);
            return res.status(422).send(errors);
        } else { text = sanitize(text); }

        try {
            const query = { _id: new ObjectId(id) };
            if (!await messagesColl.findOne(query)) return res.sendStatus(404);
            await messagesColl.updateOne({ _id: new ObjectId(id) }, {
                $set: {
                    to,
                    text,
                    type,
                },
            })
            return res.sendStatus(204);
        } catch (err) {
            console.log(err);
            return res.sendStatus(500);
        }
    });
}

const PORT = 5000;
app.listen(PORT, () => console.log(`Connected, port: ${PORT}`));

main();
