/**
 * Organizations.
 *
 * The deployment is a single plant / single tenant (Phase 0 decision A1), but
 * incident memory is org-scoped end to end so the isolation boundary exists in
 * the data model and in every query from day one. Organization identity is
 * ALWAYS derived from the authenticated user - a request body can never
 * nominate an organization.
 */
import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { collections, type OrganizationDoc, type UserDoc } from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';

export const DEFAULT_ORG_NAME = 'Default Organization';
export const DEFAULT_ORG_SLUG = 'default';

export interface OrgActor {
  orgId: ObjectId;
  orgSlug: string;
  userId: ObjectId;
  username: string;
  role: string;
}

/**
 * Resolve the acting user's organization from the live user document.
 *
 * Users created before Phase 6 have no `organization_id`; those rows resolve
 * to the default organization, which `ensureDefaultOrganization` guarantees to
 * exist. The id is never taken from the request body or the JWT.
 */
export async function resolveActorOrg(
  db: Db,
  userId: ObjectId | string,
  username: string,
  role: string,
): Promise<OrgActor> {
  const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
  const user = await collections
    .users(db)
    .findOne<UserDoc>({ _id: id }, { projection: { organization_id: 1 } });

  const org = await (user?.organization_id
    ? collections.organizations(db).findOne({ _id: user.organization_id })
    : collections.organizations(db).findOne({ slug: DEFAULT_ORG_SLUG }));
  if (!org) {
    // prepareDatabase seeds the default org; unreachable unless the DB was
    // manually truncated.
    throw ApiError.internal('The default organization is missing from the database.');
  }

  return {
    orgId: org._id,
    orgSlug: org.slug,
    userId: id,
    username,
    role,
  };
}

/** A live, active organization or a 404. */
export async function requireLiveOrganization(db: Db, orgId: ObjectId): Promise<OrganizationDoc> {
  const org = await collections.organizations(db).findOne({ _id: orgId, is_active: true });
  if (!org) throw ApiError.notFound('Organization not found.');
  return org;
}
