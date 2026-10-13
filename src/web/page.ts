/** Single page: bots, streaming transcript, steer, approval cards, audit link. */
export const WEB_PAGE = `<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<title>pi-personal-agents</title>
<style>
  body { font-family: sans-serif; margin: 1.5rem; }
  #log { white-space: pre-wrap; border: 1px solid #ccc; min-height: 8rem; padding: 0.5rem; }
  form, section { margin-top: 1rem; }
  button { margin-right: 0.4rem; }
</style>
<body>
<header><a href="/api/audit">审计</a> <a href="/login">登录</a></header>
<label>Bot <select id="bot"></select></label>
<label>会话 <input id="conversation" value="root"></label>
<div id="log"></div>
<form id="send">
  <input id="text" placeholder="消息" autocomplete="off">
  <button type="submit">发送</button>
  <button type="button" id="steer">转向</button>
</form>
<section id="approvals"></section>
<script>
const log = document.querySelector("#log");
const bot = document.querySelector("#bot");
const conversation = document.querySelector("#conversation");
const text = document.querySelector("#text");
const approvals = document.querySelector("#approvals");
async function loadBots() {
  const response = await fetch("/api/bots");
  const body = await response.json();
  bot.innerHTML = "";
  for (const name of body.bots) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    bot.append(option);
  }
}
function render(entries) {
  log.textContent = entries.map((entry) => entry.kind + ": " + entry.text).join("\\n");
}
function renderApprovals(items) {
  approvals.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("article");
    card.textContent = item.bot + " " + item.tool;
    for (const decision of ["allow_once", "allow_always", "deny"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = decision;
      button.addEventListener("click", () => {
        socket.send(JSON.stringify({ type: "decide", id: item.id, decision }));
      });
      card.append(button);
    }
    approvals.append(card);
  }
}
const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ type: "watch", bot: bot.value || "chief", conversationId: conversation.value || "root" }));
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "view") render(message.entries);
  if (message.type === "approvals") renderApprovals(message.items);
});
document.querySelector("#send").addEventListener("submit", (event) => {
  event.preventDefault();
  socket.send(JSON.stringify({
    type: "submit",
    bot: bot.value,
    conversationId: conversation.value || "root",
    content: text.value,
    requestId: "web-" + Date.now(),
    whenBusy: "followUp",
  }));
  text.value = "";
});
document.querySelector("#steer").addEventListener("click", () => {
  socket.send(JSON.stringify({
    type: "submit",
    bot: bot.value,
    conversationId: conversation.value || "root",
    content: text.value,
    requestId: "steer-" + Date.now(),
    whenBusy: "steer",
  }));
});
loadBots();
</script>
</body>
</html>`;
