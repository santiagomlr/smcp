// Words for "keep awake", shared by the main window and the menu bar panel.
(function (root) {
  function clock(iso) {
    const at = new Date(iso);
    const sameDay = at.toDateString() === new Date().toDateString();
    const options = sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" };
    return at.toLocaleString(SMCP_I18N.locale(), options);
  }

  /** One sentence for what keep awake is doing now. */
  function nowText(status) {
    if (!status.active) return tr("Off. The computer sleeps on its usual schedule.");
    let text;
    if (status.endsAt) text = tr("On until {time}", { time: clock(status.endsAt) });
    else if (status.watching?.kind === "claude") text = tr("On while Claude is open");
    else if (status.watching) text = tr("On while {app} is open", { app: status.watching.name });
    else text = tr("On until you turn it off");
    if (status.startedBy === "ai") text += ` · ${tr("started by Claude")}`;
    if (status.reason) text += ` · ${status.reason}`;
    if (status.verified === false && status.holding) text += ` · ${tr("not confirmed by macOS yet")}`;
    return text;
  }

  /** The warnings, worded in the app's language. */
  function warningText(warning) {
    switch (warning.code) {
      case "not-verified":
        return tr("macOS does not show SMCP's keep-awake assertion yet. If this lasts, turn keep awake off and on.");
      case "lid-setup":
        return tr("Closing the lid will still put the computer to sleep until closed-lid mode is set up in Settings.");
      case "lid-battery":
        return tr("On battery with the lid closed: keep it ventilated. It stops at the battery level you chose.");
      case "display-never":
        return tr("The screen is set to never turn off in System Settings, so it stays on. Use Turn screen off, or set Turn display off when inactive in System Settings > Lock Screen.");
      case "display-held":
        return tr("{apps} is keeping the screen on. Use Turn screen off, or close it.", { apps: warning.apps });
      case "low-power":
        return tr("Low Power Mode is on, so macOS may slow down network and background work.");
      case "sleep-disabled-elsewhere":
        return tr("System sleep is turned off by another app, such as Amphetamine Enhancer.");
      default:
        return warning.text;
    }
  }

  /** What the length menu should show for the session in progress. */
  function lengthOf(status) {
    if (!status.active) return null;
    if (status.watching?.kind === "claude") return "claude";
    if (!status.endsAt) return "0";
    return null;
  }

  /** Turns a length menu value into what start() takes. */
  function startArgs(value) {
    if (value === "claude") return { whileClaude: true };
    const minutes = Number(value);
    return minutes > 0 ? { minutes } : {};
  }

  const REASONS = {
    "lid closed": () => tr("Lid closed"),
    idle: () => tr("Idle"),
    "low battery": () => tr("Low battery"),
    "too hot": () => tr("Too hot"),
    "power button": () => tr("Power button"),
    maintenance: () => tr("Maintenance"),
    "an app or the person asked": () => tr("Asked by an app or by you"),
  };

  function sleepText(sleep) {
    return `${clock(sleep.at)} · ${REASONS[sleep.reason]?.() ?? sleep.reason}`;
  }

  root.SMCP_AWAKE = { nowText, warningText, lengthOf, startArgs, sleepText };
})(globalThis);
