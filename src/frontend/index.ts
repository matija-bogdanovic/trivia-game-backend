import { websocketPort } from "../ports.js";
import { handleJoinGame } from "./functions/handle_join_game.js";

// Add proper error handling to this file later on when you finish the project
document.addEventListener("DOMContentLoaded", function (_) {
  // Get the user count element, which could be null
  const userCountEl = document.getElementById(
    "userCount"
  ) as HTMLElement | null;
  // Get the button element and type it as HTMLButtonElement
  const button = document.getElementById("button") as HTMLButtonElement | null;
  // Create a WebSocket connection
  const socket = new WebSocket(`${websocketPort}://${window.location.host}/`);

  // Set the onmessage handler with proper typing
  socket.onmessage = (event: MessageEvent) => {
    const data = JSON.parse(event.data);
    if (data.amountExceeded) {
      button.disabled = true;
      userCountEl.innerText =
        "The amount of people in the room playing has exceeded, or you're trying to set the username again. If you've set the username previously please don't try again.";
      return;
    }
    if (data.type === "buttonClick" && data.exists === true) {
      userCountEl.innerText = `Username "${data.username}" already exists in the database. Please choose a different one.`;
    } else if (data.type === "buttonClick" && data.exists === false) {
      button.disabled = false;
      window.location.href = "/game.html";
    }
  };
  // loggedin user
  // Set up the click event for the button
  socket.close = () => {
    console.log("kurac");
  };
  button.addEventListener("click", async () => {
    handleJoinGame();
  });
});
