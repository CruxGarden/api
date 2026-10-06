export default class Account {
  id: string;
  email: string;
  role: 'admin' | 'author' | 'keeper';
  homeId: string;
  created: Date;
  updated: Date;
  deleted?: Date;
  /** set while an operator has suspended the account (ADR 0083) */
  suspended?: Date | null;
  suspendedReason?: string | null;
  suspendedBy?: string | null;

  constructor(partial: Partial<Account>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, suspendedBy, ...rest } = this;
    return rest;
  }
}
