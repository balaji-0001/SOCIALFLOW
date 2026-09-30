import PDFDocument from "pdfkit";
import type { buildReport } from "./analytics-report";

/*
 * Renders the analytics report (the same data as GET /analytics) as a PDF. Only built-in PDF fonts and vector shapes
 * are used, so no font files are needed. A metric the networks don't report is never printed as a number: it is listed
 * under "Not reported by the network" with the reason, and a missing reading shows "n/a".
 */

export type ReportData = Awaited<ReturnType<typeof buildReport>>;

const INK = "#1f2937";
const MUTED = "#6b7280";
const RULE = "#e5e7eb";
const ACCENT = "#2563eb";
const GOOD = "#15803d";
const BAD = "#b91c1c";

const LABELS: Record<string, string> = {
  followers: "Followers", posts: "Posts published", likes: "Likes", comments: "Comments", shares: "Shares", saves: "Saves",
  views: "Views", impressions: "Impressions", reach: "Reach", engagement: "Engagement",
};
const KPI_ORDER = ["followers", "posts", "engagement", "likes", "comments", "shares", "saves", "views", "impressions", "reach"] as const;
const PLATFORM_LABELS: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", youtube: "YouTube" };

/** Built-in PDF fonts only cover Latin-1; anything else would print as garbage, so it becomes "?". */
const safe = (text: string) => text.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7e\xa1-\xff]/gu, "?");
const fmt = (value: number | null | undefined) => (value === null || value === undefined ? "n/a" : Math.round(value).toLocaleString("en-US"));
const fmtChange = (value: number | null) => (value === null ? "no comparison" : `${value > 0 ? "+" : ""}${Math.round(value).toLocaleString("en-US")} vs previous`);

function dateLabel(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** First and last calendar day (inclusive) of the report period in its zone. */
export function rangeDays(range: ReportData["range"]): { from: string; to: string } {
  const last = new Date(Math.max(range.from.getTime(), range.to.getTime() - 1));
  return { from: dateLabel(range.from, range.timezone), to: dateLabel(last, range.timezone) };
}

export function reportFileName(range: ReportData["range"]): string {
  const days = rangeDays(range);
  return `socialflow-analytics-${days.from}_to_${days.to}.pdf`;
}

export function renderReportPdf(report: ReportData, opts: { workspaceName: string; generatedAt?: Date; compress?: boolean }): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 48, compress: opts.compress ?? true, info: { Title: "SocialFlow analytics report", Author: "SocialFlow", Creator: "SocialFlow" } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const tz = report.range.timezone;
  const days = rangeDays(report.range);
  const prevDays = rangeDays({ ...report.range, from: report.range.previousFrom, to: report.range.previousTo });
  const generated = opts.generatedAt ?? new Date();

  const ensure = (height: number) => { if (doc.y + height > bottom()) doc.addPage(); };
  const heading = (text: string) => {
    ensure(60);
    doc.moveDown(0.8).font("Helvetica-Bold").fontSize(13).fillColor(INK).text(text, left, doc.y, { width });
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor(RULE).lineWidth(1).stroke();
    doc.moveDown(0.6);
  };

  // Title block.
  doc.font("Helvetica-Bold").fontSize(22).fillColor(INK).text("Analytics report", left, doc.y, { width });
  doc.font("Helvetica").fontSize(11).fillColor(MUTED).text(safe(opts.workspaceName), { width });
  doc.moveDown(0.5).fontSize(10).fillColor(INK);
  doc.text(`Period: ${days.from} to ${days.to} (${tz})`, { width });
  doc.fillColor(MUTED).text(`Compared with: ${prevDays.from} to ${prevDays.to}`, { width });
  const filterNames = report.accounts.map((a) => `${PLATFORM_LABELS[a.platform] ?? a.platform}: ${safe(a.displayName)}`);
  doc.text(`Accounts (${report.accounts.length}): ${filterNames.length ? filterNames.join(", ") : "none connected"}`, { width });
  doc.text(report.lastCollectedAt ? `Latest network reading: ${report.lastCollectedAt.toISOString().replace("T", " ").slice(0, 16)} UTC` : "No network readings have been collected yet.", { width });

  // KPI cards for metrics that are available; unavailable ones are listed separately, never shown as zero.
  heading("Key numbers");
  const kpis = report.kpis as Record<string, { value: number | null; change: number | null; available: boolean; reason: string | null; rate?: number | null }>;
  const shown = KPI_ORDER.filter((key) => kpis[key]!.available);
  const cols = 3;
  const gap = 10;
  const cardW = (width - gap * (cols - 1)) / cols;
  const cardH = 62;
  for (let i = 0; i < shown.length; i += cols) {
    ensure(cardH + 8);
    const y = doc.y;
    shown.slice(i, i + cols).forEach((key, j) => {
      const kpi = kpis[key]!;
      const x = left + j * (cardW + gap);
      doc.roundedRect(x, y, cardW, cardH, 5).lineWidth(1).strokeColor(RULE).stroke();
      doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(LABELS[key]!, x + 10, y + 8, { width: cardW - 20, lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(18).fillColor(INK).text(kpi.value === null ? "No data yet" : fmt(kpi.value), x + 10, y + 21, { width: cardW - 20, lineBreak: false });
      const rate = key === "engagement" && kpi.rate !== null && kpi.rate !== undefined ? ` | rate ${(kpi.rate * 100).toFixed(2)}%` : "";
      doc.font("Helvetica").fontSize(8).fillColor(kpi.change === null ? MUTED : kpi.change >= 0 ? GOOD : BAD).text(`${fmtChange(kpi.change)}${rate}`, x + 10, y + 46, { width: cardW - 20, lineBreak: false });
    });
    doc.y = y + cardH + 8;
  }
  doc.x = left;

  // Simple vector bar chart: posts per day.
  const activity = report.series.activity;
  if (activity.length > 0) {
    heading("Posts published per day");
    const chartH = 70;
    ensure(chartH + 30);
    const top = doc.y + 4;
    const max = Math.max(1, ...activity.map((d) => d.posts));
    const slot = width / activity.length;
    const barW = Math.max(1, Math.min(18, slot * 0.7));
    doc.moveTo(left, top + chartH).lineTo(left + width, top + chartH).strokeColor(RULE).lineWidth(1).stroke();
    activity.forEach((d, i) => {
      const h = (d.posts / max) * chartH;
      if (h > 0) doc.rect(left + i * slot + (slot - barW) / 2, top + chartH - h, barW, h).fill(ACCENT);
    });
    doc.font("Helvetica").fontSize(8).fillColor(MUTED);
    doc.text(`Most in a day: ${max}. ${activity[0]!.date} to ${activity[activity.length - 1]!.date}`, left, top + chartH + 5, { width });
    doc.y = top + chartH + 18;
  }

  // Per-platform table.
  heading("By platform");
  const table = (columns: Array<{ title: string; w: number; align?: "left" | "right" }>, rows: string[][]) => {
    const total = columns.reduce((s, c) => s + c.w, 0);
    const scale = width / total;
    const drawRow = (cells: string[], bold: boolean, color: string) => {
      ensure(18);
      const y = doc.y;
      let x = left;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(color);
      cells.forEach((cell, i) => {
        const w = columns[i]!.w * scale;
        doc.text(cell, x + 2, y + 3, { width: w - 6, align: columns[i]!.align ?? "left", lineBreak: false, ellipsis: true });
        x += w;
      });
      doc.moveTo(left, y + 16).lineTo(left + width, y + 16).strokeColor(RULE).lineWidth(0.5).stroke();
      doc.y = y + 17;
    };
    drawRow(columns.map((c) => c.title), true, MUTED);
    for (const row of rows) drawRow(row, false, INK);
    doc.x = left;
  };
  if (report.platforms.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("No connected accounts match this report.", left, doc.y, { width });
  } else {
    table(
      [{ title: "Platform", w: 12 }, { title: "Accounts", w: 8, align: "right" }, { title: "Followers", w: 10, align: "right" }, { title: "Posts", w: 7, align: "right" }, { title: "Likes", w: 8, align: "right" },
        { title: "Comments", w: 10, align: "right" }, { title: "Shares", w: 8, align: "right" }, { title: "Views", w: 9, align: "right" }, { title: "Reach", w: 9, align: "right" }],
      report.platforms.map((p) => [PLATFORM_LABELS[p.platform] ?? p.platform, fmt(p.accounts), fmt(p.followers), fmt(p.posts), fmt(p.likes), fmt(p.comments), fmt(p.shares), fmt(p.views), fmt(p.reach)]),
    );
  }

  // Top posts.
  heading("Top posts");
  if (report.topPosts.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("No published posts with readings in this period.", left, doc.y, { width });
  } else {
    table(
      [{ title: "Post", w: 34 }, { title: "Network", w: 10 }, { title: "Published", w: 11 }, { title: "Likes", w: 7, align: "right" }, { title: "Comments", w: 9, align: "right" }, { title: "Shares", w: 7, align: "right" }, { title: "Engagement", w: 10, align: "right" }],
      report.topPosts.map((p) => [safe(p.content).slice(0, 80) || "(no text)", PLATFORM_LABELS[p.platform] ?? p.platform, dateLabel(p.publishedAt, tz), fmt(p.likes), fmt(p.comments), fmt(p.shares), fmt(p.engagement)]),
    );
  }

  // Honest gaps.
  const missing = KPI_ORDER.filter((key) => !kpis[key]!.available);
  if (missing.length > 0) {
    heading("Not reported by the network");
    doc.font("Helvetica").fontSize(9.5).fillColor(INK);
    for (const key of missing) {
      ensure(30);
      doc.text(`Not reported by the network: ${LABELS[key]} - ${safe(kpis[key]!.reason ?? "The network does not report it.")}`, left, doc.y, { width });
      doc.moveDown(0.3);
    }
  }

  ensure(30);
  doc.moveDown(1).font("Helvetica").fontSize(8).fillColor(MUTED).text(`Generated ${generated.toISOString().replace("T", " ").slice(0, 16)} UTC by SocialFlow. Numbers are the latest readings the networks reported.`, left, doc.y, { width });
  doc.end();
  return done;
}
