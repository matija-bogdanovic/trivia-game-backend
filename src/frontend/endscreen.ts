import { websocketPort } from "../ports.js";

document.addEventListener("DOMContentLoaded", () => {
  const winner = document.getElementById("winner");
  const playagain = document.getElementById("playagain");
  const wss = new WebSocket(`${websocketPort}/endscreen`);

  if (wss.readyState === WebSocket.CONNECTING) {
    winner.innerText = "Connecting to server...";
  }

  wss.onopen = () => {
    wss.send(JSON.stringify({ getWinner: "getWinner" }));

    wss.onmessage = (event) => {
      const parsedEvent = JSON.parse(event.data);
      if (parsedEvent)
      winner.innerText = `${parsedEvent.topPlayers[0]} is the winner of this match!`;
    };
  };

  playagain.addEventListener("click", () => {
    wss.send(JSON.stringify({ playAgain: true }));
    window.location.href = "/index.html";
  });
});
