import type { Delivery, Message } from "./types.ts";

export type NewMessage = Omit<Message, "id" | "at" | "reactions" | "delivery" | "request"> &
  Partial<Pick<Message, "delivery" | "request">>;

export type Store = {
  /** Bumped by every mutation; the UI re-renders only when it changes. */
  version: number;
  messages: Message[];
  add(message: NewMessage): Message;
  setDelivery(messageId: string, delivery: Delivery): void;
  /** The newest message addressable by `ref`, which is how a reply or reaction finds its target. */
  findByRef(ref: string): Message | undefined;
  addReaction(messageId: string, emoji: string): void;
  clear(): void;
};

export function createStore(): Store {
  let sequence = 0;

  const store: Store = {
    version: 0,
    messages: [],

    add(message) {
      sequence += 1;
      const stored: Message = {
        ...message,
        id: `m${sequence}`,
        at: new Date().toISOString(),
        reactions: [],
        delivery: message.delivery ?? null,
        request: message.request ?? null,
      };
      store.messages.push(stored);
      store.version += 1;
      return stored;
    },

    setDelivery(messageId, delivery) {
      const message = store.messages.find((candidate) => candidate.id === messageId);
      if (message === undefined) return;
      message.delivery = delivery;
      store.version += 1;
    },

    findByRef(ref) {
      for (let index = store.messages.length - 1; index >= 0; index -= 1) {
        const message = store.messages[index];
        if (message !== undefined && message.refs.includes(ref)) return message;
      }
      return undefined;
    },

    addReaction(messageId, emoji) {
      const message = store.messages.find((candidate) => candidate.id === messageId);
      if (message === undefined || message.reactions.includes(emoji)) return;
      message.reactions.push(emoji);
      store.version += 1;
    },

    clear() {
      store.messages = [];
      store.version += 1;
    },
  };

  return store;
}
