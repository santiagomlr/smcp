// Words and little helpers for the night light, shared by the main window and the menu bar panel.
(function (root) {
  const LOOKS = {
    ember: "Ember",
    candle: "Candle",
    incandescent: "Incandescent",
    halogen: "Halogen",
    fluorescent: "Fluorescent",
    daylight: "Daylight",
  };
  const PHASES = { day: "Daytime", sunset: "Sunset", bedtime: "Bedtime" };

  function looksLike(kelvin) {
    if (kelvin <= 1300) return "ember";
    if (kelvin <= 2000) return "candle";
    if (kelvin <= 3000) return "incandescent";
    if (kelvin <= 4000) return "halogen";
    if (kelvin <= 5500) return "fluorescent";
    return "daylight";
  }

  const kelvinLabel = (kelvin) => `${kelvin}K · ${tr(LOOKS[looksLike(Number(kelvin))])}`;

  function clock(iso) {
    return new Date(iso).toLocaleTimeString(SMCP_I18N.locale(), { hour: "numeric", minute: "2-digit" });
  }

  /** One sentence for what the screen is doing now and what comes next. */
  function nowText(status) {
    if (status.supported === false) return tr("Only available on a Mac.");
    if (!status.enabled || !status.now) return tr("Off. The screen shows its normal colors.");
    const { now } = status;
    if (now.source === "manual") {
      return now.kelvin >= 6500 && now.brightness >= 1
        ? tr("Paused until {time}", { time: clock(now.until) })
        : tr("Set by hand: {kelvin} until {time}", { kelvin: kelvinLabel(now.kelvin), time: clock(now.until) });
    }
    const current = tr("{phase}: {kelvin}", { phase: tr(PHASES[now.phase]), kelvin: kelvinLabel(now.kelvin) });
    const next = status.nextChange ? ` · ${tr("{phase} at {time}", { phase: tr(PHASES[status.nextChange.phase]), time: clock(status.nextChange.at) })}` : "";
    return current + next;
  }

  /** Which preset these settings match, or "custom". */
  function presetOf(settings, presets) {
    for (const [name, preset] of Object.entries(presets ?? {})) {
      if (["day", "sunset", "bedtime", "dim"].every((key) => settings[key] === preset[key])) return name;
    }
    return "custom";
  }

  root.SMCP_NIGHTLIGHT = { kelvinLabel, nowText, presetOf, clock };
})(globalThis);
