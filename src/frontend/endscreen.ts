document.addEventListener("DOMContentLoaded", () => {
  const winner = document.getElementById("winner");
  const playagain = document.getElementById("playagain");
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wss = new WebSocket(`${protocol}://${window.location.host}/endscreen`);

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
