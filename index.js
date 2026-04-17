const { App } = require("@slack/bolt");
const Database = require("better-sqlite3");
const Holidays = require("date-holidays");
const path = require("path");

const hd = new Holidays("CA", "QC");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const db = new Database(path.join(__dirname, "data", "bureau.db"));
db.pragma("journal_mode = WAL");

const CHANNEL_IDS = (process.env.SLACK_CHANNEL_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];

const PRIVATE_QC_HOLIDAYS = new Set([
  "New Year's Day",
  "National Patriots' Day",
  "National Holiday",
  "Canada Day",
  "Labour Day",
  "Thanksgiving",
  "Christmas Day",
]);

// Init DB
db.exec(`
  CREATE TABLE IF NOT EXISTS presence (
    user_id TEXT,
    week TEXT,
    day TEXT,
    channel TEXT,
    PRIMARY KEY (user_id, week, day, channel)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    week TEXT,
    channel TEXT,
    ts TEXT,
    PRIMARY KEY (week, channel)
  )
`);

// Migration: add channel column / composite PK if tables predate multi-channel support
function migrateSchema() {
  const legacyChannel = process.env.SLACK_CHANNEL_ID || CHANNEL_IDS[0];
  const presenceCols = db.prepare("PRAGMA table_info(presence)").all();
  if (!presenceCols.some((c) => c.name === "channel")) {
    db.exec(`
      ALTER TABLE presence RENAME TO presence_old;
      CREATE TABLE presence (
        user_id TEXT,
        week TEXT,
        day TEXT,
        channel TEXT,
        PRIMARY KEY (user_id, week, day, channel)
      );
      INSERT INTO presence (user_id, week, day, channel)
      SELECT user_id, week, day, '${legacyChannel}' FROM presence_old;
      DROP TABLE presence_old;
    `);
  }

  const messagesCols = db.prepare("PRAGMA table_info(messages)").all();
  const messagesPk = messagesCols.filter((c) => c.pk > 0).map((c) => c.name);
  if (messagesPk.length === 1 && messagesPk[0] === "week") {
    db.exec(`
      ALTER TABLE messages RENAME TO messages_old;
      CREATE TABLE messages (
        week TEXT,
        channel TEXT,
        ts TEXT,
        PRIMARY KEY (week, channel)
      );
      INSERT INTO messages (week, channel, ts)
      SELECT week, channel, ts FROM messages_old;
      DROP TABLE messages_old;
    `);
  }
}
migrateSchema();

function currentWeek() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  return monday.toISOString().split("T")[0];
}

function nextWeek() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysUntilNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + daysUntilNextMonday);
  return monday.toISOString().split("T")[0];
}

function getPresence(week, channel) {
  const rows = db
    .prepare("SELECT user_id, day FROM presence WHERE week = ? AND channel = ?")
    .all(week, channel);
  const result = {};
  DAYS.forEach((d) => (result[d] = []));
  rows.forEach(({ user_id, day }) => result[day].push(user_id));
  return result;
}

function isPublicHoliday(date) {
  const result = hd.isHoliday(date);
  return result && result.some((h) => h.type === "public" && PRIVATE_QC_HOLIDAYS.has(h.name));
}

// Returns a Set of day names (e.g. "Lundi") that are public holidays for the given week
function getHolidaysForWeek(weekMonday) {
  const holidays = new Set();
  const monday = new Date(weekMonday);
  for (let i = 0; i < 5; i++) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + i);
    if (isPublicHoliday(date)) {
      holidays.add(DAYS[i]);
    }
  }
  return holidays;
}

function buildBlocks(week, presence) {
  const holidays = getHolidaysForWeek(week);
  const monday = new Date(week);
  const dateLabel = `Semaine du ${monday.getUTCDate()} ${monday.toLocaleString("fr-FR", { month: "long", timeZone: "UTC" })}`;

  const dayButtons = DAYS.map((day) => {
    const holiday = holidays.has(day);
    const count = presence[day].length;
    return {
      type: "button",
      text: {
        type: "plain_text",
        text: holiday ? `${day} (Férié)` : `${day} (${count})`,
      },
      value: week,
      action_id: `toggle_${day}`,
      style: holiday ? "danger" : count > 0 ? "primary" : undefined,
    };
  });

  const recap = DAYS.map((day) => {
    if (holidays.has(day)) {
      return `*${day}* : _Férié_`;
    }
    const users = presence[day];
    return `*${day}* : ${users.length > 0 ? users.map((u) => `<@${u}>`).join(", ") : "—"}`;
  }).join("\n");

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Qui vient au bureau ?*\n${dateLabel}` },
    },
    { type: "actions", elements: dayButtons },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: recap } },
  ];
}

function buildFrozenBlocks(week) {
  const monday = new Date(week);
  const dateLabel = `Semaine du ${monday.getUTCDate()} ${monday.toLocaleString("fr-FR", { month: "long", timeZone: "UTC" })}`;

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Qui vient au bureau ?*\n${dateLabel} (terminé)` },
    },
  ];
}

async function postWeeklyMessage(week) {
  const previous = db.prepare("SELECT channel, ts FROM messages WHERE week != ?").all(week);
  for (const prev of previous) {
    try {
      await app.client.pins.remove({ channel: prev.channel, timestamp: prev.ts });
    } catch (err) {
      console.error(`Échec du désépinglage précédent : ${err.message}`);
    }
  }

  for (const channel of CHANNEL_IDS) {
    const presence = getPresence(week, channel);
    const result = await app.client.chat.postMessage({
      channel,
      text: `Présences bureau — semaine du ${week}`,
      blocks: buildBlocks(week, presence),
    });

    db.prepare("INSERT OR REPLACE INTO messages (week, channel, ts) VALUES (?, ?, ?)").run(
      week,
      channel,
      result.ts,
    );

    try {
      await app.client.pins.add({ channel, timestamp: result.ts });
    } catch (err) {
      console.error(`Échec de l'épinglage : ${err.message}`);
    }

    console.log(`Message envoyé pour la semaine du ${week} dans ${channel}`);
  }
}

// Handle button clicks
DAYS.forEach((day) => {
  app.action(`toggle_${day}`, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const week = body.actions[0].value || nextWeek();
    const channel = body.container.channel_id;

    // Ignore clicks on holiday days
    const holidays = getHolidaysForWeek(week);
    if (holidays.has(day)) return;

    const existing = db
      .prepare("SELECT 1 FROM presence WHERE user_id = ? AND week = ? AND day = ? AND channel = ?")
      .get(userId, week, day, channel);

    if (existing) {
      db.prepare(
        "DELETE FROM presence WHERE user_id = ? AND week = ? AND day = ? AND channel = ?",
      ).run(userId, week, day, channel);
    } else {
      db.prepare(
        "INSERT OR IGNORE INTO presence (user_id, week, day, channel) VALUES (?, ?, ?, ?)",
      ).run(userId, week, day, channel);
    }

    const presence = getPresence(week, channel);
    await client.chat.update({
      channel,
      ts: body.container.message_ts,
      text: `Présences bureau — semaine du ${week}`,
      blocks: buildBlocks(week, presence),
    });
  });
});

// Send message at 9am on the last business day of the week (Friday, or earlier if holidays)
function getNextSendDate() {
  const now = new Date();

  const dayOfWeek = now.getDay();

  // Find next Friday
  const friday = new Date(now);
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
  friday.setDate(now.getDate() + daysUntilFriday);
  friday.setHours(9, 0, 0, 0);

  // If we're past that time, jump to next week's Friday
  if (friday <= now) {
    friday.setDate(friday.getDate() + 7);
  }

  // Walk back from Friday to find the last business day (skip holidays and weekends)
  const sendDate = new Date(friday);
  while (isPublicHoliday(sendDate) || sendDate.getDay() === 0 || sendDate.getDay() === 6) {
    sendDate.setDate(sendDate.getDate() - 1);
  }

  if (sendDate < friday) {
    const dayNames = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
    console.log(`Vendredi ${friday.toISOString().split("T")[0]} férié → envoi ${dayNames[sendDate.getDay()]} ${sendDate.toISOString().split("T")[0]}`);
  }

  sendDate.setHours(9, 0, 0, 0);
  return sendDate;
}

function scheduleNextMessage() {
  const now = new Date();
  const sendDate = getNextSendDate();
  const ms = sendDate - now;
  console.log(`Prochain message prévu : ${sendDate.toISOString()} (dans ${Math.round(ms / 1000 / 60)} min)`);
  setTimeout(async () => {
    await postWeeklyMessage(nextWeek());
    scheduleNextMessage();
  }, ms);
}

function getNextFreezeDate() {
  const now = new Date();

  const dayOfWeek = now.getDay();

  // Find next Friday
  const friday = new Date(now);
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
  friday.setDate(now.getDate() + daysUntilFriday);
  friday.setHours(17, 0, 0, 0);

  // If we're past Friday 17h, jump to next week
  if (friday <= now) {
    friday.setDate(friday.getDate() + 7);
  }

  // Walk back from Friday if it's a holiday
  const freezeDate = new Date(friday);
  while (isPublicHoliday(freezeDate) || freezeDate.getDay() === 0 || freezeDate.getDay() === 6) {
    freezeDate.setDate(freezeDate.getDate() - 1);
  }

  freezeDate.setHours(17, 0, 0, 0);
  return freezeDate;
}

function scheduleFreezeMessage() {
  const now = new Date();
  const freezeDate = getNextFreezeDate();
  const ms = freezeDate - now;
  console.log(`Gel du message prévu : ${freezeDate.toISOString()} (dans ${Math.round(ms / 1000 / 60)} min)`);
  setTimeout(async () => {
    await freezeCurrentMessage(app.client);
    scheduleFreezeMessage();
  }, ms);
}

async function freezeCurrentMessage(client) {
  const week = currentWeek();
  const messages = db.prepare("SELECT channel, ts FROM messages WHERE week = ?").all(week);
  if (messages.length === 0) return;

  for (const msg of messages) {
    await client.chat.update({
      channel: msg.channel,
      ts: msg.ts,
      text: `Présences bureau — semaine du ${week} (terminé)`,
      blocks: buildFrozenBlocks(week),
    });

    try {
      await client.pins.remove({ channel: msg.channel, timestamp: msg.ts });
    } catch (err) {
      console.error(`Échec du désépinglage : ${err.message}`);
    }

    db.prepare("DELETE FROM presence WHERE week = ? AND channel = ?").run(week, msg.channel);
    db.prepare("DELETE FROM messages WHERE week = ? AND channel = ?").run(week, msg.channel);
    console.log(`Message de la semaine du ${week} figé dans ${msg.channel}`);
  }
}

(async () => {
  await app.start();
  console.log("Bureau Bot démarré en Socket Mode");
  scheduleNextMessage();
  scheduleFreezeMessage();
})();
