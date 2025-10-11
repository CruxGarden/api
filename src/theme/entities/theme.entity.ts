export default class Theme {
  id: string;
  authorId: string;
  homeId: string;
  title: string;
  key: string;
  description?: string;
  primaryColor: string;
  secondaryColor: string;
  tertiaryColor: string;
  quaternaryColor: string;
  borderRadius?: string;
  backgroundColor?: string;
  panelColor?: string;
  textColor?: string;
  font?: string;
  mode?: string;
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Theme>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
