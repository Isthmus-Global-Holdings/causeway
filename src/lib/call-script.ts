// The rep's call script: one text shared by every call, shown at the top of
// the call page with the contact's details filled in. Plain text, so what the
// rep wrote is exactly what they read.

export const MAX_SCRIPT = 20_000;

export interface ScriptVars {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  fitReason: string | null;
  myName: string | null;
}

export const SCRIPT_PLACEHOLDERS: { token: string; key: keyof ScriptVars; what: string }[] = [
  { token: '{first_name}', key: 'firstName', what: 'their first name' },
  { token: '{last_name}', key: 'lastName', what: 'their last name' },
  { token: '{name}', key: 'name', what: 'their full name' },
  { token: '{title}', key: 'title', what: 'their job title' },
  { token: '{company}', key: 'company', what: 'their company' },
  { token: '{fit_reason}', key: 'fitReason', what: "why you picked them (the company's Fit: line)" },
  { token: '{my_name}', key: 'myName', what: 'your from name' },
];

// Swaps in the contact's details. A placeholder with no value, or one that
// isn't known, stays as written, so a gap shows instead of vanishing.
export function fillScript(template: string, vars: ScriptVars): string {
  return template.replace(/\{([a-z_]+)\}/gi, (match, name: string) => {
    const known = SCRIPT_PLACEHOLDERS.find((p) => p.token === `{${name.toLowerCase()}}`);
    const value = known ? vars[known.key]?.trim() : null;
    return value || match;
  });
}

export function normalizeScript(text: string): string {
  return text.replace(/\r\n?/g, '\n').trimEnd();
}
