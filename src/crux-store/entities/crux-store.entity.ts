export default class Store {
  id: string;
  cruxId: string;
  authorId: string;
  visitorId: string | null;
  key: string;
  value: any;
  mode: string;
  createdAt: Date;
  updatedAt: Date;

  constructor(partial: Partial<Store>) {
    Object.assign(this, partial);
  }
}
