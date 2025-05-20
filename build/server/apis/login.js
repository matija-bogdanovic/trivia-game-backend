import { client } from "../middleware/connections.js";
import jwt from "jsonwebtoken";
export async function registerUser(req, res, next) {
    var _a;
    try {
        const username = (_a = req.body.username) === null || _a === void 0 ? void 0 : _a.trim();
        if (!username ||
            username.length < 3 ||
            username.length > 20 ||
            !/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({ error: "Invalid username format" });
        }
        const dbArrayOfNames = (await client.json.get("usernames:usernames", {
            path: "$..usernames[*]",
        }));
        if (!dbArrayOfNames) {
            return res.status(500).json({ error: "Server error" });
        }
        const playerArrayUI = JSON.parse(dbArrayOfNames);
        if (playerArrayUI.some((element) => element.username === req.body.username)) {
            res.send(JSON.stringify({ error: "That username already exists in the database!" }));
        }
        else {
            const token = jwt.sign({ username: req.body.username }, `${process.env.SECRET}`, {
                expiresIn: "48h",
            });
            await client.json.arrAppend("usernames:usernames", "$.usernames", {
                username: req.body.username,
                health: 5,
            });
            res.cookie("token", token, {
                httpOnly: true,
                secure: false,
                sameSite: "lax",
                maxAge: 172800000,
            });
            res.json({ success: true, username: req.body.username });
        }
    }
    catch (error) {
        next(error);
    }
}
//# sourceMappingURL=login.js.map