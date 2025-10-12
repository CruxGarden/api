import { Request } from 'express';
import { HealthStatusType, ServiceHealthType } from './enums';

export interface AuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthRequest extends Request {
  account: JwtPayload;
}

export interface HealthStatus {
  status: HealthStatusType;
  version: string;
  timestamp: string;
  services: {
    database: ServiceHealth;
    redis: ServiceHealth;
  };
}

export interface JwtPayload {
  id: string;
  email: string;
  role: string;
  grantId: string;
  exp: number;
  iat: number;
}

export interface RepositoryResponse<T> {
  data: T | null;
  error: Error | null;
}

export interface ServiceHealth {
  status: ServiceHealthType;
  responseTime?: number;
  error?: string;
}
