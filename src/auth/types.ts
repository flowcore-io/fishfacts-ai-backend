export type FishfactsUser = {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  groupId: number;
  groupName: string | null;
  authorities: string[];
  fleets: { id: number; name: string }[];
  serviceProvidersId: number[];
  newsId: number[];
  eventsId: number[];
};

export type AuthContext = {
  token: string;
  user: FishfactsUser;
};

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}
