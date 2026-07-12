const CONSEQUENTIAL_WORDS = [
  "buy",
  "purchase",
  "pay",
  "checkout",
  "delete",
  "remove",
  "send",
  "submit",
  "publish",
  "post",
  "confirm",
  "transfer",
  "unsubscribe"
];

export function isPotentiallyConsequential(description: string): boolean {
  const value = description.toLowerCase();
  return CONSEQUENTIAL_WORDS.some((word) => value.includes(word));
}

export function requireConfirmation(description: string, confirmed: boolean): void {
  if (isPotentiallyConsequential(description) && !confirmed) {
    throw new Error(
      `Confirmation required for a potentially consequential action: ${description}. ` +
        "Ask the user, then retry with confirmed=true."
    );
  }
}
