import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { Actor } from '../auth-model.js';
import type { Pagination } from '../schemas.js';
import { HttpError } from '../http.js';
import { ArticleEntity,CommentEntity,StatusAuditEntity } from './entities.js';
const missing=()=>new HttpError(404,'NOT_FOUND','找不到資料');
export function createOrmCommentStore(source:DataSource){return {
 list:(articleId:string,query:Pagination)=>source.transaction('REPEATABLE READ',async manager=>{
  const article=await manager.findOneBy(ArticleEntity,{id:articleId});if(article?.status!=='published')throw missing();
  const repository=manager.getRepository(CommentEntity);const data=await repository.find({where:{articleId},order:{createdAt:'ASC',id:'ASC'},skip:(query.page-1)*query.pageSize,take:query.pageSize});const total=await repository.countBy({articleId});return {data,meta:{...query,total}};
 }),
 create:(articleId:string,content:string,actor:Actor)=>source.transaction('READ COMMITTED',async manager=>{
  const article=await manager.getRepository(ArticleEntity).createQueryBuilder('a').setLock('pessimistic_write').where('a.id = :id',{id:articleId}).getOne();if(article?.status!=='published')throw missing();
  const row=manager.create(CommentEntity,{id:'c_'+randomUUID(),articleId,authorId:actor.id,content});return {data:await manager.save(row)};
 }),
 async remove(id:string,actor:Actor){const repository=source.getRepository(CommentEntity);const row=await repository.findOneBy({id});if(!row)throw missing();if(actor.id!==row.authorId&&actor.role!=='admin')throw new HttpError(403,'FORBIDDEN','沒有刪除留言的權限');const result=await repository.delete({id,authorId:row.authorId});if(result.affected!==1)throw missing();},
 audits:(articleId:string,query:Pagination)=>source.transaction('REPEATABLE READ',async manager=>{
  if(!await manager.existsBy(ArticleEntity,{id:articleId}))throw missing();const repository=manager.getRepository(StatusAuditEntity);const data=await repository.find({where:{articleId},order:{toVersion:'ASC'},skip:(query.page-1)*query.pageSize,take:query.pageSize});return {data,meta:{...query,total:await repository.countBy({articleId})}};
 }),
};}
