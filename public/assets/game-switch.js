const gameParams = new URLSearchParams(window.location.search);
const requestedGame = gameParams.get("game");
const storedGame = window.localStorage.getItem("lottery-game");
const game = requestedGame === "pl3" || (!requestedGame && storedGame === "pl3")
  ? "pl3"
  : "fc3d";
const gameName = game === "pl3" ? "体彩排列3" : "福彩3D";

window.localStorage.setItem("lottery-game", game);
document.documentElement.dataset.lotteryGame = game;

window.LotteryGame = {
  id: game,
  name: gameName,
  file(fc3dFile) {
    return game === "pl3" ? `pl3-${fc3dFile}` : fc3dFile;
  },
};

function switchGame(nextGame) {
  window.localStorage.setItem("lottery-game", nextGame);
  const url = new URL(window.location.href);
  if (nextGame === "pl3") url.searchParams.set("game", "pl3");
  else url.searchParams.delete("game");
  window.location.href = url.toString();
}

function decoratePage() {
  let clock = document.querySelector(".beijing-clock");
  if (!clock) {
    clock = document.createElement("div");
    clock.className = "beijing-clock";
    clock.innerHTML =
      '<span>北京时间</span><strong data-shanghai-clock>正在校时</strong>';
    document.querySelector(".topbar")?.insertAdjacentElement("afterend", clock);
  }
  const updateClock = () => {
    const target =
      clock.querySelector("[data-shanghai-clock]") ??
      clock.querySelector("#beijing-time");
    if (!target) return;
    target.textContent = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
  };
  updateClock();
  window.setInterval(updateClock, 1000);
  const versionSwitch = document.querySelector(".version-switch");
  const anchor = clock;
  if (anchor && !document.querySelector(".game-switch")) {
    const nav = document.createElement("nav");
    nav.className = "game-switch";
    nav.setAttribute("aria-label", "切换彩票类型");
    nav.innerHTML = `
      <button type="button" data-game="fc3d" class="${game === "fc3d" ? "is-active" : ""}">
        <strong>福彩3D</strong><span>独立数据</span>
      </button>
      <button type="button" data-game="pl3" class="${game === "pl3" ? "is-active" : ""}">
        <strong>体彩排列3</strong><span>独立模型</span>
      </button>`;
    anchor.insertAdjacentElement("afterend", nav);
    nav.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => switchGame(button.dataset.game));
    });
  }

  versionSwitch?.querySelectorAll("a").forEach((link) => {
    const url = new URL(link.href, window.location.href);
    if (game === "pl3") url.searchParams.set("game", "pl3");
    else url.searchParams.delete("game");
    link.href = url.toString();
  });
  if (game === "pl3") {
    const auditFiles = {
      "full-history-integrity.json": "pl3-full-history-integrity.json",
      "full-history-training.json": "pl3-full-history-training.json",
      "v2-one-year-training.json": "pl3-v2-training.json",
      "v2-one-year-config.json": "pl3-v2-config.json",
    };
    document.querySelectorAll('a[href*="/audit/"], a[href*="./audit/"]').forEach((link) => {
      const url = new URL(link.href, window.location.href);
      const file = url.pathname.split("/").at(-1);
      if (auditFiles[file]) {
        url.pathname = url.pathname.replace(file, auditFiles[file]);
        link.href = url.toString();
      }
    });
  }

  const eyebrow = document.querySelector(".topbar .eyebrow");
  if (eyebrow) {
    eyebrow.textContent = eyebrow.textContent.replace(
      /福彩3D|体彩排列3/,
      gameName,
    );
  }
  document.title = document.title.replace(/福彩3D|体彩排列3/, gameName);
}

decoratePage();
