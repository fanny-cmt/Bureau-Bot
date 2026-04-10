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

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
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
    PRIMARY KEY (user_id, week, day)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    week TEXT PRIMARY KEY,
    channel TEXT,
    ts TEXT
  )
`);

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

function getPresence(week) {
  const rows = db.prepare("SELECT user_id, day FROM presence WHERE week = ?").all(week);
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
  const presence = getPresence(week);
  const result = await app.client.chat.postMessage({
    channel: CHANNEL_ID,
    text: `Présences bureau — semaine du ${week}`,
    blocks: buildBlocks(week, presence),
  });

  db.prepare("INSERT OR REPLACE INTO messages (week, channel, ts) VALUES (?, ?, ?)").run(week, CHANNEL_ID, result.ts);
  console.log(`Message envoyé pour la semaine du ${week}`);
}

// Handle button clicks
DAYS.forEach((day) => {
  app.action(`toggle_${day}`, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const week = body.actions[0].value || nextWeek();

    // Ignore clicks on holiday days
    const holidays = getHolidaysForWeek(week);
    if (holidays.has(day)) return;

    const existing = db
      .prepare("SELECT 1 FROM presence WHERE user_id = ? AND week = ? AND day = ?")
      .get(userId, week, day);

    if (existing) {
      db.prepare("DELETE FROM presence WHERE user_id = ? AND week = ? AND day = ?").run(userId, week, day);
    } else {
      db.prepare("INSERT OR IGNORE INTO presence (user_id, week, day) VALUES (?, ?, ?)").run(userId, week, day);
    }

    const presence = getPresence(week);
    await client.chat.update({
      channel: body.container.channel_id,
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
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7;
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
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7;
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
  const msg = db.prepare("SELECT channel, ts FROM messages WHERE week = ?").get(week);
  if (!msg) return;

  await client.chat.update({
    channel: msg.channel,
    ts: msg.ts,
    text: `Présences bureau — semaine du ${week} (terminé)`,
    blocks: buildFrozenBlocks(week),
  });

  db.prepare("DELETE FROM presence WHERE week = ?").run(week);
  db.prepare("DELETE FROM messages WHERE week = ?").run(week);
  console.log(`Message de la semaine du ${week} figé et données supprimées`);
}

(async () => {
  await app.start();
  console.log("Bureau Bot démarré en Socket Mode");
  scheduleNextMessage();
  scheduleFreezeMessage();
})();
