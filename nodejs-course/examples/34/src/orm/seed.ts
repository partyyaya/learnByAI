import type { DataSource } from 'typeorm';
import { hashPassword } from '../password.js';
import { UserEntity,ArticleEntity } from './entities.js';
const accounts=[{id:'u_demo',displayName:'Alice',email:'alice@example.test',role:'member' as const,password:'Alice-course-18!'},{id:'u_bob',displayName:'Bob',email:'bob@example.test',role:'member' as const,password:'Bob-course-18!!'},{id:'u_admin',displayName:'管理員',email:'admin@example.test',role:'admin' as const,password:'Admin-course-18!'}];
let hashes:Promise<string[]>|undefined;
export async function seedOrm(source:DataSource){
 hashes??=(async()=>{const values:string[]=[];for(const account of accounts)values.push(await hashPassword(account.password));return values;})();const passwords=await hashes;
 await source.transaction(async manager=>{
  for(const [index,{password:_password,...account}] of accounts.entries())await manager.createQueryBuilder().insert().into(UserEntity).values({...account,passwordHash:passwords[index]}).orIgnore().execute();
  for(const [id,title,status,date] of [['a_1','認識 Node HTTP','published','2026-01-03T00:00:00.000Z'],['a_2','請求與回應','published','2026-01-02T00:00:00.000Z'],['a_draft','未公開草稿','draft','2026-01-01T00:00:00.000Z']] as const)await manager.createQueryBuilder().insert().into(ArticleEntity).values({id,title,status,content:'文章內容',authorId:'u_demo',version:1,createdAt:new Date(date),updatedAt:new Date(date)}).orIgnore().execute();
 });
}
