import { TokenPayload } from '../auth/jwt';

declare global {
  namespace Express {
    interface Request {
      /** Présent après passage par le middleware requireAuth. */
      auth?: TokenPayload;
    }
  }
}

export {};
