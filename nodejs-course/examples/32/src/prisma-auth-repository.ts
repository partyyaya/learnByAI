import type { Database } from './database.js';
import type { AuthRepository } from './auth-repository.js';
const publicFields = { id: true, email: true, displayName: true, role: true } as const;
export function createPrismaAuthRepository(db: Database): AuthRepository {
  return {
    findUser: email => db.user.findUnique({ where: { email } }),
    async createUser(input) {
      try { return await db.user.create({ data: { ...input, role: 'member' }, select: publicFields }); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return null;
        throw error;
      }
    },
    findSession: tokenHash => db.session.findUnique({ where: { tokenHash }, include: { user: { select: publicFields } } }),
    async createSession(input) { await db.session.create({ data: input }); },
    rotateSession: (previousHash, next, now) => db.$transaction(async tx => {
      const old = await tx.session.updateMany({ where: { tokenHash: previousHash, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } });
      if (old.count !== 1) return false;
      await tx.session.create({ data: next });
      return true;
    }),
    async revokeSession(tokenHash, now) {
      await db.session.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: now } });
    },
  };
}
