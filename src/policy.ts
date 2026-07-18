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
  "unsubscribe",
  "order",
  "book",
  "schedule",
  "invite",
  "authorize",
  "approve",
  "grant",
  "commit",
  "merge"
];

export function isPotentiallyConsequential(description: string): boolean {
  const value = description.toLowerCase();
  return CONSEQUENTIAL_WORDS.some((word) => value.includes(word));
}
