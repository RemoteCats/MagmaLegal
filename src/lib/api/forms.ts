import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Form submissions never touch the database from the browser. `enquiries` and
// `bookings` have no anon policy at all — this server function holds the
// service-role key, so a leaked anon key cannot stuff the inbox.

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

// Bots fill every field they can see. A real person leaves this one empty.
const honeypot = z.string().max(200).optional();

const enquirySchema = z.object({
  kind: z.literal("enquiry"),
  name: trimmed(200).min(1, "Your name is required"),
  company: optionalText(200),
  email: trimmed(320).email("That does not look like an email address"),
  phone: optionalText(60),
  subject: optionalText(300),
  scope: trimmed(4000).min(1, "Tell us a little about the matter"),
  website: honeypot,
});

const bookingSchema = z.object({
  kind: z.literal("booking"),
  name: trimmed(200).min(1, "Your name is required"),
  email: trimmed(320).email("That does not look like an email address"),
  phone: optionalText(60),
  service: trimmed(200).min(1, "Choose a consultation type"),
  preferredDate: trimmed(40).min(1, "Pick a date"),
  preferredTime: trimmed(40).min(1, "Pick a time"),
  notes: optionalText(4000),
  website: honeypot,
});

const chatSchema = z.object({
  kind: z.literal("chat"),
  sessionId: trimmed(80).min(1),
  name: trimmed(200).min(1),
  email: optionalText(320),
  message: trimmed(4000).min(1),
  /** The widget could not save this to the database; email is all there is. */
  unsaved: z.boolean().optional(),
  website: honeypot,
});

export const submitFormSchema = z.discriminatedUnion("kind", [
  enquirySchema,
  bookingSchema,
  chatSchema,
]);

export type SubmitFormInput = z.infer<typeof submitFormSchema>;
export type SubmitFormResult = { ok: true; id: string | null };

export const submitForm = createServerFn({ method: "POST" })
  .validator((input: unknown) => submitFormSchema.parse(input))
  .handler(async ({ data }): Promise<SubmitFormResult> => {
    const shared = await import("./_shared.server");

    // Honeypot: answer as if it worked, write nothing, send nothing.
    if (data.website && data.website.trim() !== "") {
      return { ok: true, id: null };
    }

    if (data.kind === "chat") {
      // The widget writes its own rows under the visitor's session — RLS can
      // express "your own chat" precisely. All this does is ring the bell,
      // unless the widget could not write, when this email is the message.
      await notify(shared, {
        subject: data.unsaved
          ? `Chat message from ${data.name} (reply by email)`
          : `New chat message from ${data.name}`,
        heading: data.unsaved ? "A visitor sent a chat message" : "A visitor started a chat",
        rows: [
          ["Name", data.name],
          ["Email", data.email ?? "—"],
          ["Message", data.message],
          ["Session", data.sessionId],
        ],
        ...(data.email ? { replyTo: data.email } : {}),
        footer: data.unsaved
          ? "Live chat could not save this message, so it is not in the dashboard. Reply to the visitor by email. /api/health?probe=chat names what is wrong."
          : "Reply in the Live chat tab of the dashboard.",
      });
      return { ok: true, id: data.sessionId };
    }

    // The visitor always gets a normal "thank you". If the database cannot take
    // the row, the email below is the record, and the reason goes to the log.
    const saved = await save(shared, data);
    const unsavedNote = saved.ok
      ? ""
      : " This one could not be saved to the dashboard, so this email is the only copy; /api/health names what is wrong.";

    if (data.kind === "enquiry") {
      await notify(shared, {
        subject: `New inquiry — ${data.subject || data.name}`,
        heading: "New inquiry",
        rows: [
          ["Name", data.name],
          ["Company", data.company ?? ""],
          ["Email", data.email],
          ["Phone", data.phone ?? ""],
          ["Subject", data.subject ?? ""],
          ["Brief", data.scope],
        ],
        replyTo: data.email,
        footer: `Open the Inquiries tab of the dashboard to reply.${unsavedNote}`,
      });
    } else {
      await notify(shared, {
        subject: `New booking request — ${data.name}`,
        heading: "New consultation booking",
        rows: [
          ["Name", data.name],
          ["Email", data.email],
          ["Phone", data.phone ?? ""],
          ["Consultation", data.service],
          ["Preferred date", data.preferredDate],
          ["Preferred time", data.preferredTime],
          ["Notes", data.notes ?? ""],
        ],
        replyTo: data.email,
        footer: `Open the Bookings tab of the dashboard to confirm.${unsavedNote}`,
      });
    }

    return { ok: true, id: saved.ok ? saved.id : null };
  });

/** Writes the row, or logs why it could not. Never throws. */
async function save(
  shared: SharedModule,
  data: Exclude<SubmitFormInput, { kind: "chat" }>,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  const label = data.kind === "enquiry" ? "inquiry" : "booking";
  if (!shared.SUPABASE_URL || !shared.SERVICE_ROLE_KEY) {
    console.error(
      `[forms] an ${label} arrived, but Supabase is not configured on the server. See /api/health.`,
    );
    return { ok: false };
  }

  try {
    const db = shared.adminClient();
    const { data: row, error } =
      data.kind === "enquiry"
        ? await db
            .from("enquiries")
            .insert({
              name: data.name,
              company: data.company ?? null,
              email: data.email,
              phone: data.phone ?? null,
              subject: data.subject ?? null,
              scope: data.scope,
            })
            .select("id")
            .single()
        : await db
            .from("bookings")
            .insert({
              patient_name: data.name,
              email: data.email,
              phone: data.phone ?? null,
              service: data.service,
              preferred_date: data.preferredDate,
              preferred_time: data.preferredTime,
              notes: data.notes ?? null,
            })
            .select("id")
            .single();

    if (error) throw error;
    return { ok: true, id: String(row?.["id"] ?? "") || null };
  } catch (error) {
    console.error(`[forms] could not save the ${label}:`, shared.errorMessage(error));
    return { ok: false };
  }
}

type SharedModule = typeof import("./_shared.server");

/** The write already succeeded; a mail failure must not undo it. */
async function notify(
  shared: SharedModule,
  options: {
    subject: string;
    heading: string;
    rows: Array<[string, string]>;
    replyTo?: string;
    footer: string;
  },
): Promise<void> {
  try {
    await shared.sendEmail({
      to: shared.MAIL_NOTIFY_TO,
      subject: options.subject,
      html: shared.emailBody(options.heading, options.rows, options.footer),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    });
  } catch (error) {
    console.error("[mail] notification failed:", shared.errorMessage(error));
  }
}
