import type { DataSource,QueryFailedError } from 'typeorm';
import type { AuthRepository } from '../auth-repository.js';
import { SessionEntity,UserEntity } from './entities.js';
const fields={id:true,email:true,displayName:true,role:true} as const;
export function createOrmAuthRepository(source:DataSource):AuthRepository {
 return {
  findUser:email=>source.getRepository(UserEntity).createQueryBuilder('u').addSelect('u.passwordHash').where('u.email = :email',{email}).getOne(),
  async createUser(input){try{await source.getRepository(UserEntity).insert({...input,role:'member'});return source.getRepository(UserEntity).findOneOrFail({where:{id:input.id},select:fields});}catch(error){if((error as QueryFailedError&{driverError?:{code?:string}}).driverError?.code==='23505')return null;throw error;}},
  async findSession(tokenHash){const row=await source.getRepository(SessionEntity).findOne({where:{tokenHash},relations:{user:true}});if(!row)return null;return {...row,user:row.user?{id:row.user.id,email:row.user.email,displayName:row.user.displayName,role:row.user.role}:null};},
  async createSession(input){await source.getRepository(SessionEntity).insert(input);},
  rotateSession:(previousHash,next,now)=>source.transaction('READ COMMITTED',async manager=>{
   const result=await manager.createQueryBuilder().update(SessionEntity).set({revokedAt:now}).where('"tokenHash" = :hash AND "revokedAt" IS NULL AND "expiresAt" > :now',{hash:previousHash,now}).execute();if(result.affected!==1)return false;await manager.insert(SessionEntity,next);return true;
  }),
  async revokeSession(tokenHash,now){await source.getRepository(SessionEntity).createQueryBuilder().update().set({revokedAt:now}).where('"tokenHash" = :hash AND "revokedAt" IS NULL',{hash:tokenHash}).execute();},
 };
}
