export const classes = {
  // Websocket connection
  wss: new WebSocket("ws://whoisfaster.onrender.com/game"),
  // Localstorage username
  localStorageUsername: localStorage.getItem("username"),
  // Grab client id
  clientId: localStorage.getItem("clientId"),
  // Get the first username wherever you want to display it
  username1: document.querySelectorAll(
    '[aria-label="1st"]'
  ) as NodeListOf<HTMLElement>,
  // Get every second username where you want to display it
  username2: document.querySelectorAll(
    '[aria-label="2nd"]'
  ) as NodeListOf<HTMLSpanElement>,
  overlay: document.getElementById("overlay"),
  countdown: document.getElementById("countDown"),
  heart: document.createElement("img"),
  // Start the game button
  button: document.getElementById("startButton") as HTMLButtonElement,
  // Heart Wrapper
  heartWrapPlayer1: document.getElementById("heartWrap1") as HTMLElement,
  heartWrapPlayer2: document.getElementById("heartWrap2") as HTMLElement,
  circle: document.getElementById("circle") as HTMLElement,
  roundCount: document.getElementById("roundCount") as HTMLElement,
};
