// packages/providers/graphql/src/client/auth.ts

/**
 * @fileoverview GraphQL Auth Provider
 * @description AuthProvider implementation using a GraphQL API endpoint.
 * Supports email/password login and signup. OAuth and email-link flows are
 * not supported — those methods throw with a descriptive error.
 *
 * @version 0.0.1
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type {
  AuthProvider,
  AuthUser,
  AuthResult,
  AuthPartnerId,
  AuthMethod,
  UnsubscribeFn,
  UserRole,
  SignUpMetadata,
} from '@donotdev/core';
import { wrapAuthError, DoNotDevError, hasRoleAccess } from '@donotdev/core';

import type { GraphQLClient } from './graphqlClient';

// =============================================================================
// GraphQL payloads
// =============================================================================

interface GqlUser {
  id: string;
  email: string;
  name?: string;
}

interface AuthPayload {
  token: string;
  user: GqlUser;
}

// =============================================================================
// Map GQL user to AuthUser
// =============================================================================

function mapGqlUserToAuthUser(user: GqlUser): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.name ?? undefined,
    photoURL: undefined,
    emailVerified: false,
    role: 'user' as UserRole,
    customClaims: {},
  };
}

// =============================================================================
// GraphQLAuth
// =============================================================================

/**
 * GraphQL Auth implementation of AuthProvider.
 * Communicates with a GraphQL endpoint using `login` and `signup` mutations.
 * Token is stored in localStorage via GraphQLClient.
 *
 * Unsupported operations (OAuth, email link, etc.) throw descriptive errors.
 *
 * @version 0.0.1
 * @since 0.0.1
 */
export class GraphQLAuth implements AuthProvider {
  private currentUser: AuthUser | null = null;
  private initialized = false;
  private readonly listeners = new Set<(user: AuthUser | null) => void>();

  constructor(private readonly client: GraphQLClient) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize by restoring session from localStorage token.
   * If a token exists, validates it by calling `me` query.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const token = this.client.getToken();
    if (!token) return;

    try {
      const data = await this.client.query<{ me: GqlUser | null }>(
        `query { me { id email name } }`
      );
      if (data.me) {
        this.currentUser = mapGqlUserToAuthUser(data.me);
        this.notifyListeners(this.currentUser);
      } else {
        // Token present but invalid — clear it
        this.client.setToken(null);
        this.currentUser = null;
      }
    } catch {
      // Network error or invalid token — clear and continue unauthenticated
      this.client.setToken(null);
      this.currentUser = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Auth state
  // ---------------------------------------------------------------------------

  async getCurrentUser(): Promise<AuthUser | null> {
    if (this.currentUser) return this.currentUser;

    const token = this.client.getToken();
    if (!token) return null;

    try {
      const data = await this.client.query<{ me: GqlUser | null }>(
        `query { me { id email name } }`
      );
      if (data.me) {
        this.currentUser = mapGqlUserToAuthUser(data.me);
        return this.currentUser;
      }
      return null;
    } catch {
      return null;
    }
  }

  onAuthStateChanged(callback: (user: AuthUser | null) => void): UnsubscribeFn {
    this.listeners.add(callback);
    // Fire immediately with current state
    callback(this.currentUser);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notifyListeners(user: AuthUser | null): void {
    for (const cb of this.listeners) {
      cb(user);
    }
  }

  // ---------------------------------------------------------------------------
  // Sign in / sign up
  // ---------------------------------------------------------------------------

  async signInWithEmailAndPassword(
    email: string,
    password: string
  ): Promise<AuthUser> {
    try {
      const data = await this.client.mutate<{ login: AuthPayload }>(
        `mutation Login($email: String!, $password: String!) {
          login(email: $email, password: $password) {
            token
            user { id email name }
          }
        }`,
        { email, password }
      );

      const { token, user } = data.login;
      this.client.setToken(token);
      this.currentUser = mapGqlUserToAuthUser(user);
      this.notifyListeners(this.currentUser);
      return this.currentUser;
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(
        error instanceof Error ? error : new Error(String(error)),
        'GraphQLAuth',
        'signInWithEmailAndPassword',
        { email }
      );
    }
  }

  async createUserWithEmailAndPassword(
    email: string,
    password: string,
    metadata?: SignUpMetadata
  ): Promise<AuthUser> {
    try {
      const householdName = (metadata as Record<string, unknown> | undefined)
        ?.householdName as string | undefined;
      const name = (metadata as Record<string, unknown> | undefined)?.name as
        | string
        | undefined;

      const data = await this.client.mutate<{ signup: AuthPayload }>(
        `mutation Signup($householdName: String!, $name: String!, $email: String!, $password: String!) {
          signup(householdName: $householdName, name: $name, email: $email, password: $password) {
            token
            user { id email name }
          }
        }`,
        {
          householdName: householdName ?? '',
          name: name ?? '',
          email,
          password,
        }
      );

      const { token, user } = data.signup;
      this.client.setToken(token);
      this.currentUser = mapGqlUserToAuthUser(user);
      this.notifyListeners(this.currentUser);
      return this.currentUser;
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(
        error instanceof Error ? error : new Error(String(error)),
        'GraphQLAuth',
        'createUserWithEmailAndPassword',
        { email }
      );
    }
  }

  async signOut(): Promise<void> {
    this.client.setToken(null);
    this.currentUser = null;
    this.notifyListeners(null);
  }

  // ---------------------------------------------------------------------------
  // Token
  // ---------------------------------------------------------------------------

  async getAccessToken(): Promise<string | null> {
    return this.client.getToken();
  }

  async refreshToken(): Promise<string | null> {
    // GraphQL JWT refresh is not implemented in this backend.
    // Return existing token — consumer may re-authenticate if expired.
    return this.client.getToken();
  }

  // ---------------------------------------------------------------------------
  // Role / feature / tier checks
  // ---------------------------------------------------------------------------

  async hasRole(role: UserRole): Promise<boolean> {
    const user = await this.getCurrentUser();
    if (!user) return false;
    const userRole = user.role ?? ('guest' as UserRole);
    return hasRoleAccess(userRole, role);
  }

  async hasFeature(featureId: string): Promise<boolean> {
    const user = await this.getCurrentUser();
    if (!user?.customClaims) return false;
    const features = (user.customClaims as Record<string, unknown>).features as
      | string[]
      | undefined;
    return Array.isArray(features) && features.includes(featureId);
  }

  async hasTier(requiredTier: string): Promise<boolean> {
    const user = await this.getCurrentUser();
    if (!user?.customClaims) return false;
    const tier = (user.customClaims as Record<string, unknown>).tier as
      | string
      | undefined;
    return tier === requiredTier;
  }

  // ---------------------------------------------------------------------------
  // Convenience aliases (AuthProvider interface)
  // ---------------------------------------------------------------------------

  async signInWithEmail(
    email: string,
    password: string
  ): Promise<AuthResult | null> {
    const user = await this.signInWithEmailAndPassword(email, password);
    return { user, success: true };
  }

  async createUserWithEmail(
    email: string,
    password: string,
    metadata?: SignUpMetadata
  ): Promise<AuthResult | null> {
    const user = await this.createUserWithEmailAndPassword(
      email,
      password,
      metadata
    );
    return { user, success: true, isNewUser: true };
  }

  // ---------------------------------------------------------------------------
  // Profile updates
  // ---------------------------------------------------------------------------

  async updateUserProfile(updates: Partial<AuthUser>): Promise<void> {
    // GraphQL provider does not expose a profile update mutation.
    // Update local cached user only (display purposes).
    if (this.currentUser) {
      this.currentUser = {
        ...this.currentUser,
        ...(updates.displayName !== undefined
          ? { displayName: updates.displayName }
          : {}),
        ...(updates.photoURL !== undefined
          ? { photoURL: updates.photoURL }
          : {}),
      };
      this.notifyListeners(this.currentUser);
    }
  }

  async sendPasswordResetEmail(_email: string): Promise<void> {
    throw new Error(
      'GraphQL provider does not support password reset email. Implement a custom reset mutation on your GraphQL server.'
    );
  }

  async updatePassword(_newPassword: string): Promise<void> {
    throw new Error(
      'GraphQL provider does not support updatePassword. Implement a custom mutation on your GraphQL server.'
    );
  }

  // ---------------------------------------------------------------------------
  // Unsupported — OAuth / email link / verification
  // ---------------------------------------------------------------------------

  async signInWithPartner(
    _partnerId: AuthPartnerId,
    _method?: AuthMethod
  ): Promise<AuthResult | null> {
    throw new Error(
      'GraphQL provider does not support OAuth sign-in. Use email/password authentication.'
    );
  }

  async linkWithPartner(
    _partnerId: AuthPartnerId,
    _method?: AuthMethod
  ): Promise<AuthResult | null> {
    throw new Error('GraphQL provider does not support OAuth account linking.');
  }

  async signInWithGoogleCredential(
    _credential: string
  ): Promise<AuthResult | null> {
    throw new Error(
      'GraphQL provider does not support Google credential sign-in.'
    );
  }

  async sendEmailVerification(): Promise<void> {
    throw new Error(
      'GraphQL provider does not support email verification. Implement on your GraphQL server.'
    );
  }

  async sendSignInLinkToEmail(
    _email: string,
    _actionCodeSettings?: { url: string; handleCodeInApp: boolean }
  ): Promise<void> {
    throw new Error('GraphQL provider does not support email sign-in links.');
  }

  async signInWithEmailLink(
    _email: string,
    _emailLink?: string
  ): Promise<AuthResult | null> {
    throw new Error('GraphQL provider does not support email link sign-in.');
  }

  isSignInWithEmailLink(_emailLink?: string): boolean {
    return false;
  }

  async getEmailVerificationStatus(): Promise<{ status: string }> {
    return { status: 'pending' };
  }

  async isEmailVerificationEnabled(): Promise<boolean> {
    return false;
  }

  async reauthenticateWithPassword(_password: string): Promise<void> {
    throw new Error(
      'GraphQL provider does not support reauthentication. Sign out and sign in again.'
    );
  }

  async reauthenticateWithProvider(
    _partnerId: AuthPartnerId,
    _method?: AuthMethod
  ): Promise<void> {
    throw new Error(
      'GraphQL provider does not support OAuth reauthentication.'
    );
  }

  async deleteAccount(_password?: string): Promise<void> {
    throw new Error(
      'GraphQL provider does not support account deletion. Implement a deleteAccount mutation on your GraphQL server.'
    );
  }
}
