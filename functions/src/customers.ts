/**
 * After-sale: link a won school to its school in the LearnXR product, score how actively it uses LearnXR, and
 * remind the team before renewal. Also the spam check for website forms that feed the sales pipeline.
 */

export type ProductSchool = { id: string; name: string; city: string; website: string; phone: string };
export type Row = Record<string, unknown>;

const str = (v: unknown) => String(v ?? "").trim().replace(/^"|"$/g, "");

export function hostOf(url: unknown): string {
  return str(url)
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/)[0];
}

const digits10 = (v: unknown) => {
  const d = str(v).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};

const words = (s: unknown) =>
  new Set(
    str(s)
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !["school", "the", "public", "international", "academy", "senior", "secondary"].includes(w))
  );

/** Product schools that look like this sales school, best first, with why they matched. */
export function suggestProductSchools(rows: Row[], schools: ProductSchool[]): Array<ProductSchool & { score: number; reasons: string[] }> {
  const hosts = new Set(rows.flatMap((r) => [hostOf(r.Website), str(r["Email ID"]).toLowerCase().split("@")[1] || ""]).filter(Boolean));
  const phones = new Set(rows.flatMap((r) => [digits10(r["Phone number"]), digits10(r.WhatsApp_number)]).filter(Boolean));
  const nameWords = new Set(rows.flatMap((r) => [...words(r["School Name"])]));
  const cities = new Set(rows.map((r) => str(r.City).toLowerCase()).filter(Boolean));
  return schools
    .map((s) => {
      const reasons: string[] = [];
      let score = 0;
      if (s.website && hosts.has(hostOf(s.website))) {
        score += 60;
        reasons.push("same website");
      }
      if (s.phone && phones.has(digits10(s.phone))) {
        score += 50;
        reasons.push("same phone");
      }
      const shared = [...words(s.name)].filter((w) => nameWords.has(w)).length;
      if (shared) {
        score += Math.min(30, shared * 15);
        reasons.push("similar name");
      }
      if (s.city && cities.has(s.city.toLowerCase())) {
        score += 10;
        reasons.push("same city");
      }
      return { ...s, score, reasons };
    })
    .filter((s) => s.score >= 25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export type UsageInput = {
  /** Product users at this school: role and when they last did something (lesson launch or class session). */
  users: Array<{ uid: string; role: string; lastActiveAt: number | null }>;
  now?: number;
  renewalAt?: number | null;
};

export type Health = {
  teachers: number;
  activeTeachers: number;
  students: number;
  activeStudents: number;
  score: number;
  band: "healthy" | "watch" | "at risk" | "not started";
  renewalAt: string | null;
  daysToRenewal: number | null;
};

const DAY = 86_400_000;

/**
 * Health from active teachers and students in the last 30 days against how many are enrolled. Teachers weigh more
 * (they run the lessons). A school close to renewal with weak usage is "at risk".
 */
export function customerHealth({ users, now = Date.now(), renewalAt = null }: UsageInput): Health {
  const recent = (t: number | null) => t !== null && now - t <= 30 * DAY;
  const teachers = users.filter((u) => u.role === "teacher");
  const students = users.filter((u) => u.role === "student");
  const activeTeachers = teachers.filter((u) => recent(u.lastActiveAt)).length;
  const activeStudents = students.filter((u) => recent(u.lastActiveAt)).length;
  const share = (a: number, n: number) => (n ? a / n : 0);
  const score = Math.round(100 * (0.6 * share(activeTeachers, teachers.length) + 0.4 * share(activeStudents, students.length)));
  const daysToRenewal = renewalAt ? Math.ceil((renewalAt - now) / DAY) : null;
  let band: Health["band"];
  if (!teachers.length && !students.length) band = "not started";
  else if (score >= 60) band = "healthy";
  else if (score >= 30 && !(daysToRenewal !== null && daysToRenewal <= 30)) band = "watch";
  else band = "at risk";
  return {
    teachers: teachers.length,
    activeTeachers,
    students: students.length,
    activeStudents,
    score,
    band,
    renewalAt: renewalAt ? new Date(renewalAt).toISOString() : null,
    daysToRenewal,
  };
}

/** Default renewal: a year after the deal was won. */
export function defaultRenewalAt(rows: Row[]): number | null {
  const won = rows.map((r) => Date.parse(str(r.Won_at))).filter(Number.isFinite);
  return won.length ? Math.max(...won) + 365 * DAY : null;
}

/** Which renewal reminder (60, 30 or 7 days before) is due now, if any. */
export function renewalReminderDue(renewalAt: number, now = Date.now()): 60 | 30 | 7 | null {
  const days = Math.ceil((renewalAt - now) / DAY);
  if (days < 0) return null;
  if (days <= 7) return 7;
  if (days <= 30) return 30;
  if (days <= 60) return 60;
  return null;
}

const SPAM_PHRASES = [
  "writing needs",
  "marketing channel",
  "seo",
  "backlink",
  "guest post",
  "web design",
  "website design",
  "lead generation service",
  "crypto",
  "bitcoin",
  "loan",
  "casino",
  "rank your",
  "traffic to your",
  "unsubscribe from",
];

/**
 * Website form messages that shouldn't become sales leads: spam pitches, gibberish, and our own tests. Returns
 * the reason, or null when the message looks real.
 */
export function formSpamReason(input: { name?: unknown; email?: unknown; subject?: unknown; message?: unknown }): string | null {
  const email = str(input.email).toLowerCase();
  const subject = str(input.subject);
  const message = str(input.message);
  const text = `${subject} ${message}`.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return "no valid email";
  if (email.endsWith("@altiereality.com") || /\b(test|testing|verification|end to end|pwcheck|backlog)\b|^pwcheck/i.test(subject)) return "internal test";
  if (`${subject}${message}`.replace(/[^a-z]/gi, "").length < 15) return "too short";
  if (SPAM_PHRASES.some((p) => text.includes(p))) return "sales pitch";
  if ((text.match(/https?:\/\//g) || []).length > 1) return "links";
  const letters = `${str(input.name)}${subject}`.replace(/[^a-z]/gi, "");
  if (letters.length >= 6 && !/[aeiou]/i.test(letters.slice(0, 12))) return "gibberish";
  if (/^[A-Z]{5,}$/.test(subject) && !/\s/.test(subject)) return "gibberish";
  return null;
}
