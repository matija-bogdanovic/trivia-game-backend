document.addEventListener("DOMContentLoaded", () => {
    const winner = document.getElementById("winner");
    const playagain = document.getElementById("playagain");
    const wss = new WebSocket("http://localhost:3000/endscreen");
    wss.onopen = () => {
        wss.send(JSON.stringify({ getWinner: "getWinner" }));
        wss.onmessage = (event) => {
            const parsedEvent = JSON.parse(event.data);
            winner.innerText = `${parsedEvent.topPlayers[0]} is the winner of this match!`;
        };
    };
    playagain.addEventListener("click", () => {
        wss.send(JSON.stringify({ playAgain: true }));
        window.location.href = "/index.html";
    });
});
//# sourceMappingURL=endscreen.js.map