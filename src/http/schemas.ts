import { Type, Static } from 'typebox';

// InSales callback parameters
export const InstallParams = Type.Object({
  shop: Type.String({ minLength: 1 }),
  insales_id: Type.String({ minLength: 1 }),
  token: Type.String({ minLength: 1 }),
});

export type InstallParamsType = Static<typeof InstallParams>;

export const LoginParams = Type.Object({
  shop: Type.String({ minLength: 1 }),
  insales_id: Type.String({ minLength: 1 }),
  user_id: Type.Optional(Type.String()),
});

export type LoginParamsType = Static<typeof LoginParams>;

export const AutoLoginParams = Type.Object({
  token: Type.Optional(Type.String()),
  token2: Type.Optional(Type.String()),
  token3: Type.Optional(Type.String()),
  user_email: Type.Optional(Type.String()),
  user_name: Type.Optional(Type.String()),
  user_id: Type.Optional(Type.String()),
  email_confirmed: Type.Optional(Type.String()),
});

export type AutoLoginParamsType = Static<typeof AutoLoginParams>;

export const UninstallParams = Type.Object({
  shop: Type.String({ minLength: 1 }),
  insales_id: Type.String({ minLength: 1 }),
  token: Type.String({ minLength: 1 }),
});

export type UninstallParamsType = Static<typeof UninstallParams>;