import { client } from "../middleware/connections.js";
export async function getUsernames(_, res) {
    const playerArrayDB = (await client.json.get("usernames:usernames", {
        path: "$..usernames[*]",
    }));
    res.json({ information: JSON.parse(playerArrayDB) });
}
//# sourceMappingURL=get_usernames.js.map