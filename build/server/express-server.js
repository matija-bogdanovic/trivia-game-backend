import express from 'express';
const app = express();
const port = 3001;
app.get("/", (req, res) => {
    res.send("Kurac");
});
app.listen(port, () => {
    console.log("Example app listening on port 3001");
});
//# sourceMappingURL=express-server.js.map