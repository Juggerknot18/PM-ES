document.documentElement.classList.add("js");

const menuButton = document.querySelector(".menu-button");
const primaryNav = document.querySelector("#primary-navigation");

function ensureTelemetryLink(nav) {
  const links = Array.from(nav.querySelectorAll("a"));
  const hasTelemetry = links.some((link) => {
    const path = new URL(link.href, window.location.href).pathname;
    return /\/telemetry\/?$/.test(path);
  });

  if (hasTelemetry) return;

  const systemsLink = links.find((link) => {
    const path = new URL(link.href, window.location.href).pathname;
    return /\/systems\/?$/.test(path);
  });

  if (!systemsLink) return;

  const telemetryLink = document.createElement("a");
  telemetryLink.href = systemsLink.getAttribute("href").replace(/systems\/?$/, "telemetry/");
  telemetryLink.textContent = "Telemetry";
  systemsLink.insertAdjacentElement("afterend", telemetryLink);
}

document.querySelectorAll(".primary-nav, .footer-links").forEach(ensureTelemetryLink);

if (menuButton && primaryNav) {
  menuButton.addEventListener("click", () => {
    const expanded = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!expanded));
    primaryNav.classList.toggle("is-open", !expanded);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && primaryNav.classList.contains("is-open")) {
      menuButton.setAttribute("aria-expanded", "false");
      primaryNav.classList.remove("is-open");
      menuButton.focus();
    }
  });
}
