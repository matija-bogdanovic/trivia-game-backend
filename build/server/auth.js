import { client } from "./database_connection.js";
import jwt from "jsonwebtoken";
export async function registerUser(req, res) {
    const dbArrayOfNames = (await client.json.get("usernames:usernames", {
        path: "$..usernames[*]",
    }));
    const playerArrayUI = JSON.parse(dbArrayOfNames);
    if (playerArrayUI.some((element) => element.username === req.body.username)) {
        res.send(JSON.stringify({ error: "Kurcina!" }));
    }
    else {
        const token = jwt.sign({ username: req.body.username }, "kuracbre", {
            expiresIn: "1h",
        });
        res.cookie("token", token, {
            httpOnly: true,
            secure: true,
            sameSite: "strict",
            maxAge: 60 * 60 * 1000,
        });
        res.json({ token: token, success: true, username: req.body.username });
        await client.json.arrAppend("usernames:usernames", "$.usernames", {
            username: req.body.username,
            health: 5,
        });
    }
}
//# sourceMappingURL=auth.js.map