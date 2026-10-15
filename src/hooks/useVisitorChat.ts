import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatMessage } from "@/lib/database.types";
import { submitForm } from "@/lib/api/forms";
import { describeError } from "@/lib/readable-error";
import { isSupabaseConfigured } from "@/lib/public-config";
import { visitorSupabase as supabase } from "@/lib/supabase";

const STORAGE_KEY = "haven.chat.session";

export type ChatStatus = "loading" | "new" | "open";

export type VisitorChat = {
  status: ChatStatus;
  sessionId: string | null;
  messages: ChatMessage[];
  sending: boolean;
  start: (input: { name: string; email: string; message: string }) => Promise<void>;
  send: (body: string) => Promise<boolean>;
  reset: () => void;
};

function readStoredSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredSession(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode — the conversation just will not survive a reload */
  }
}

/**
 * Visitors never see why a chat write failed: the message is shown as sent,
 * emailed to the firm instead, and the real reason goes to the console where
 * whoever runs the site will look. /api/health?probe=chat names the fix.
 */
function logChatFailure(step: string, error: unknown): void {
  const { message, kind, hint, code } = describeError(error);
  const detail = [message, hint, code ? `(${code})` : ""].filter(Boolean).join(" — ");
  const advice =
    kind === "anonymous-disabled"
      ? "Turn on anonymous sign-ins in Supabase → Authentication → Sign In / Providers."
      : kind === "network"
        ? "The Supabase project could not be reached; it may be paused."
        : "Run /api/health?probe=chat to see which step fails and why.";
  console.error(
    `[chat] ${step} failed: ${detail}\n[chat] ${advice} The message was emailed to the firm instead.`,
  );
}

/** Conversations that live only in this tab, carried by email. */
const UNSAVED_PREFIX = "unsaved-";
const isUnsaved = (id: string) => id.startsWith(UNSAVED_PREFIX);

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function localMessage(sessionId: string, body: string): ChatMessage {
  return {
    id: newId(),
    session_id: sessionId,
    sender: "visitor",
    body,
    created_at: new Date().toISOString(),
  };
}

async function sessionIsLost(sessionId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("chat_sessions")
    .select("id")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) return false;
  return data === null;
}

/** Signs in anonymously, reusing an existing session rather than making a new
 *  user on every reload. Every chat row then carries a real `auth.uid()`. */
async function ensureVisitorSession(): Promise<string> {
  const { data: existing } = await supabase.auth.getSession();
  if (existing.session?.user) {
    armRealtime(existing.session.access_token);
    return existing.session.user.id;
  }

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  if (!data.user) throw new Error("Supabase returned no user for the anonymous sign-in.");
  armRealtime(data.session?.access_token);
  return data.user.id;
}

/**
 * Hand the access token to the realtime socket.
 *
 * postgres_changes on an RLS-protected table are filtered against the socket's
 * own JWT, not the REST one. supabase-js normally syncs this on auth state
 * change, but the client here is built lazily on first access, so the sign-in
 * can land before anything is listening. Setting it outright is cheap.
 */
function armRealtime(token: string | undefined): void {
  if (!token) return;
  try {
    supabase.realtime.setAuth(token);
  } catch {
    /* older clients sync this themselves */
  }
}

export function useVisitorChat(): VisitorChat {
  const [status, setStatus] = useState<ChatStatus>("loading");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState(false);
  // Who the visitor said they were, for the email that carries a message the
  // database would not take.
  const visitor = useRef<{ name: string; email?: string }>({ name: "Website visitor" });

  const notify = useServerFn(submitForm);

  // Realtime echoes back the row we just inserted. Both paths funnel through
  // here, and the id decides.
  const mergeMessage = useCallback((incoming: ChatMessage) => {
    setMessages((current) =>
      current.some((message) => message.id === incoming.id)
        ? current
        : [...current, incoming].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    );
  }, []);

  /** Sends one message to the firm by email. Never throws. */
  const emailMessage = useCallback(
    async (id: string, message: string) => {
      try {
        await notify({
          data: {
            kind: "chat",
            sessionId: id,
            name: visitor.current.name,
            email: visitor.current.email,
            message,
            unsaved: isUnsaved(id),
          },
        });
      } catch (caught) {
        console.error("[chat] the email fallback failed too:", describeError(caught).message);
      }
    },
    [notify],
  );

  const syncMessages = useCallback(
    async (id: string) => {
      const { data, error: readError } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("session_id", id)
        .order("created_at", { ascending: true });
      if (readError) return;
      for (const row of (data ?? []) as ChatMessage[]) mergeMessage(row);
    },
    [mergeMessage],
  );

  // Rejoin an existing conversation on mount. Anything that goes wrong just
  // offers a fresh conversation.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const stored = readStoredSession();
      if (!stored || !isSupabaseConfigured()) {
        if (!cancelled) setStatus("new");
        return;
      }

      try {
        await ensureVisitorSession();

        const { data: session, error: sessionError } = await supabase
          .from("chat_sessions")
          .select("id, visitor_name, visitor_email")
          .eq("id", stored)
          .maybeSingle();

        if (sessionError) throw sessionError;

        // The row is gone (deleted, or a different anonymous user now) —
        // forget the id rather than retrying against it forever.
        if (!session) {
          writeStoredSession(null);
          if (!cancelled) setStatus("new");
          return;
        }

        const { data: history, error: historyError } = await supabase
          .from("chat_messages")
          .select("*")
          .eq("session_id", stored)
          .order("created_at", { ascending: true });

        if (historyError) throw historyError;

        if (cancelled) return;
        const row = session as { visitor_name?: string | null; visitor_email?: string | null };
        visitor.current = {
          name: row.visitor_name || "Website visitor",
          ...(row.visitor_email ? { email: row.visitor_email } : {}),
        };
        setMessages((history ?? []) as ChatMessage[]);
        setSessionId(stored);
        setStatus("open");
      } catch (caught) {
        logChatFailure("rejoining the conversation", caught);
        if (!cancelled) setStatus("new");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // One subscription, filtered to this conversation.
  useEffect(() => {
    if (!sessionId || isUnsaved(sessionId) || !isSupabaseConfigured()) return;

    const channel = supabase
      .channel(`chat:${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => mergeMessage(payload.new as ChatMessage),
      )
      // A silent .subscribe() hides CHANNEL_ERROR and TIMED_OUT, which is how a
      // thread ends up looking connected while no reply ever arrives.
      .subscribe((status, err) => {
        setLive(status === "SUBSCRIBED");
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn(`[realtime] chat channel ${status}`, err ?? "");
        }
        if (status === "SUBSCRIBED") void syncMessages(sessionId);
      });

    return () => {
      setLive(false);
      void supabase.removeChannel(channel);
    };
  }, [sessionId, mergeMessage, syncMessages]);

  // Poll as well: slowly while the channel is up, quickly when it is not, so a
  // staff reply still lands even where realtime is unavailable.
  useEffect(() => {
    if (!sessionId || isUnsaved(sessionId) || !isSupabaseConfigured()) return;
    const id = setInterval(() => void syncMessages(sessionId), live ? 20000 : 4000);
    return () => clearInterval(id);
  }, [sessionId, live, syncMessages]);

  const start = useCallback(
    async (input: { name: string; email: string; message: string }) => {
      setSending(true);
      visitor.current = {
        name: input.name,
        ...(input.email ? { email: input.email } : {}),
      };
      try {
        if (!isSupabaseConfigured()) throw new Error("Supabase is not configured.");
        await ensureVisitorSession();

        // visitor_id defaults to auth.uid() in the database, so the row can
        // only ever belong to the session that created it.
        const { data: session, error: sessionError } = await supabase
          .from("chat_sessions")
          .insert({
            visitor_name: input.name,
            visitor_email: input.email || null,
          })
          .select("id")
          .single();

        if (sessionError) throw sessionError;
        const id = String(session["id"]);

        const { data: message, error: messageError } = await supabase
          .from("chat_messages")
          .insert({ session_id: id, sender: "visitor", body: input.message })
          .select("*")
          .single();

        if (messageError) throw messageError;

        writeStoredSession(id);
        setMessages([message as ChatMessage]);
        setSessionId(id);
        setStatus("open");

        // Rows are already written; this only rings the bell.
        void emailMessage(id, input.message);
      } catch (caught) {
        logChatFailure("starting a conversation", caught);
        const id = `${UNSAVED_PREFIX}${newId()}`;
        setMessages([localMessage(id, input.message)]);
        setSessionId(id);
        setStatus("open");
        void emailMessage(id, input.message);
      } finally {
        setSending(false);
      }
    },
    [emailMessage],
  );

  const send = useCallback(
    async (body: string): Promise<boolean> => {
      const text = body.trim();
      if (!sessionId || text === "") return false;

      if (isUnsaved(sessionId)) {
        mergeMessage(localMessage(sessionId, text));
        void emailMessage(sessionId, text);
        return true;
      }

      setSending(true);
      try {
        // The conversation is restored from localStorage, which outlives the
        // access token. Without this the insert can go out unauthenticated and
        // be refused by RLS for a reason that reads like a bug in the chat.
        await ensureVisitorSession();

        // .select().single() so the message appears immediately instead of
        // waiting on the realtime round trip; mergeMessage drops the echo.
        const { data: message, error: insertError } = await supabase
          .from("chat_messages")
          .insert({ session_id: sessionId, sender: "visitor", body: text })
          .select("*")
          .single();

        if (insertError) throw insertError;
        mergeMessage(message as ChatMessage);
        return true;
      } catch (caught) {
        logChatFailure("sending a message", caught);

        // A refusal can mean the conversation no longer belongs to this
        // browser; forget it so the next visit starts clean. A request that
        // never completed says nothing about ownership, so leave it alone.
        const { kind } = describeError(caught);
        if (kind !== "network" && (await sessionIsLost(sessionId))) writeStoredSession(null);

        // Carry on by email for the rest of this conversation.
        const id = `${UNSAVED_PREFIX}${newId()}`;
        setSessionId(id);
        mergeMessage(localMessage(id, text));
        void emailMessage(id, text);
        return true;
      } finally {
        setSending(false);
      }
    },
    [sessionId, mergeMessage, emailMessage],
  );

  const reset = useCallback(() => {
    writeStoredSession(null);
    setSessionId(null);
    setMessages([]);
    setStatus("new");
  }, []);

  return { status, sessionId, messages, sending, start, send, reset };
}
