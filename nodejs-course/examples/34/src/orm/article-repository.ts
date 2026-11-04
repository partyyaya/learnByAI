import type { DataSource,Repository,SelectQueryBuilder } from 'typeorm';
import type { ArticleScope } from '../article-model.js';
import type { ArticleRepository } from '../article-repository.js';
import { ArticleEntity,StatusAuditEntity } from './entities.js';
function scoped(query:SelectQueryBuilder<ArticleEntity>,scope:ArticleScope){if(scope.kind==='public')query.andWhere('a.status = :publicStatus',{publicStatus:'published'});else if(scope.kind==='author')query.andWhere('a.authorId = :authorId',{authorId:scope.authorId});return query;}
export function createOrmArticleRepository(source:DataSource,repository=source.getRepository(ArticleEntity)):ArticleRepository {
 return {
  list:({page,pageSize,q,sort,status},scope)=>source.transaction('REPEATABLE READ',async manager=>{
   const query=scoped(manager.getRepository(ArticleEntity).createQueryBuilder('a'),scope);
   if(status)query.andWhere('a.status = :status',{status});if(q!==undefined)query.andWhere('a.title ILIKE :q',{q:'%'+q.replace(/[\\%_]/g,'\\$&')+'%'});
   const total=await query.getCount();const direction=sort==='oldest'?'ASC':'DESC';const data=await query.orderBy('a.createdAt',direction).addOrderBy('a.id',direction).offset((page-1)*pageSize).limit(pageSize).getMany();return {data,meta:{page,pageSize,total}};
  }),
  findVisible:(id,scope)=>scoped(repository.createQueryBuilder('a').where('a.id = :id',{id}),scope).getOne(),
  async create(input){const now=new Date();await repository.insert({...input,status:'draft',version:1,createdAt:now,updatedAt:now});return repository.findOneByOrFail({id:input.id});},
  withTransaction:work=>source.transaction('READ COMMITTED',async manager=>work({
   findById:id=>manager.findOneBy(ArticleEntity,{id}),
   async appendStatusAudit(input){await manager.insert(StatusAuditEntity,input);},
   async updateIfCurrent(current,changes){
    const result=await manager.createQueryBuilder().update(ArticleEntity).set({...changes,version:()=> '"version" + 1',updatedAt:()=> 'CURRENT_TIMESTAMP'})
      .where('"id" = :id AND "authorId" = :authorId AND "version" = :version AND "status" = :status',{id:current.id,authorId:current.authorId,version:current.version,status:current.status}).execute();
    if(result.affected!==1)return null;return manager.findOneByOrFail(ArticleEntity,{id:current.id});
   },
  })),
 };
}
