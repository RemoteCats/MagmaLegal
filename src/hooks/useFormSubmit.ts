import { useServerFn } from "@tanstack/react-start";
import { useCallback, useState, type FormEvent } from "react";

import { submitForm, type SubmitFormInput } from "@/lib/api/forms";
import { describeError } from "@/lib/readable-error";

export type FormValues = Record<string, string>;

/**
 * What a visitor sees when a submission fails. A validation message is about
 * their input, so it is shown; anything else is ours to fix, so it goes to the
 * console and they get a plain "try again".
 */
function visitorMessage(error: unknown): string {
  const { message } = describeError(error);
  try {
    const issues = JSON.parse(message) as Array<{ message?: unknown }>;
    const first = Array.isArray(issues) ? issues[0]?.message : undefined;
    if (typeof first === "string" && first) return first;
  } catch {
    /* not a validation error */
  }
  console.error("[forms] submission failed:", message);
  return "That did not go through. Please try again in a moment.";
}

export type FormSubmit<T extends FormValues> = {
  values: T;
  setField: (name: keyof T & string, value: string) => void;
  submitting: boolean;
  success: boolean;
  error: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  reset: () => void;
};

/**
 * Form state plus the one server round trip. The browser never writes to
 * `enquiries` or `bookings` directly — `submitForm` holds the service-role key
 * and is the only thing that can.
 */
export function useFormSubmit<T extends FormValues>(
  initial: T,
  build: (values: T) => SubmitFormInput,
): FormSubmit<T> {
  const [values, setValues] = useState<T>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useServerFn(submitForm);

  const setField = useCallback((name: keyof T & string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setError(null);
  }, []);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) return;

      setSubmitting(true);
      setError(null);

      void (async () => {
        try {
          await send({ data: build(values) });
          setSuccess(true);
        } catch (caught) {
          setError(visitorMessage(caught));
        } finally {
          setSubmitting(false);
        }
      })();
    },
    [build, send, submitting, values],
  );

  const reset = useCallback(() => {
    setValues(initial);
    setSuccess(false);
    setError(null);
  }, [initial]);

  return { values, setField, submitting, success, error, onSubmit, reset };
}
