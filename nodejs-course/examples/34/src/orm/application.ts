import { checkOrmReady } from './readiness.js';
import { Module,type DynamicModule } from '@nestjs/common';
import { DataSource,Repository } from 'typeorm';
import { TypeOrmModule,getRepositoryToken,type TypeOrmModuleOptions } from '@nestjs/typeorm';
import { createArticleServer } from '../server.js';
import type { ApplicationOptions } from '../application.js';
import { DATABASE,CHECK_READY,ARTICLE_REPOSITORY,ARTICLE_SERVICE,AUTH_OPTIONS,AUTH_REPOSITORY,AUTH_SERVICE } from '../tokens.js';
import { STORE } from '../comments.module.js';
import { createArticleService } from '../article-service.js';
import { createAuthService } from '../auth-service.js';
import { resolveAuthOptions } from '../auth-options.js';
import type { AuthOptions } from '../auth-options.js';
import { createOrmArticleRepository } from './article-repository.js';
import { createOrmAuthRepository } from './auth-repository.js';
import { createOrmCommentStore } from './comment-store.js';
import { ormEntities,ArticleEntity,UserEntity,SessionEntity,CommentEntity,StatusAuditEntity } from './entities.js';
@Module({}) class OrmDatabaseModule {
 static register(source:DataSource):DynamicModule{return {module:OrmDatabaseModule,imports:[TypeOrmModule.forRootAsync({useFactory:()=>source.options as TypeOrmModuleOptions,dataSourceFactory:async()=>source})],providers:[{provide:DATABASE,useValue:source},{provide:CHECK_READY,useValue:()=>checkOrmReady(source)}],exports:[DATABASE,CHECK_READY,TypeOrmModule]};}
}
@Module({}) class OrmArticleCore {
 static register(database:DynamicModule):DynamicModule{return {module:OrmArticleCore,imports:[database,TypeOrmModule.forFeature([ArticleEntity])],providers:[{provide:ARTICLE_REPOSITORY,inject:[DataSource,getRepositoryToken(ArticleEntity)],useFactory:(source:DataSource,repository:Repository<ArticleEntity>)=>createOrmArticleRepository(source,repository)},{provide:ARTICLE_SERVICE,inject:[ARTICLE_REPOSITORY],useFactory:createArticleService}],exports:[ARTICLE_SERVICE]};}
}
@Module({}) class OrmAuthCore {
 static register(database:DynamicModule,options:Readonly<AuthOptions>):DynamicModule{return {module:OrmAuthCore,imports:[database,TypeOrmModule.forFeature([UserEntity,SessionEntity])],providers:[{provide:AUTH_OPTIONS,useValue:options},{provide:AUTH_REPOSITORY,inject:[DataSource],useFactory:createOrmAuthRepository},{provide:AUTH_SERVICE,inject:[AUTH_REPOSITORY,AUTH_OPTIONS],useFactory:createAuthService}],exports:[AUTH_SERVICE,AUTH_OPTIONS]};}
}
@Module({}) class OrmCommentsCore {
 static register(database:DynamicModule):DynamicModule{return {module:OrmCommentsCore,imports:[database,TypeOrmModule.forFeature([CommentEntity,StatusAuditEntity])],providers:[{provide:STORE,inject:[DataSource],useFactory:createOrmCommentStore}],exports:[STORE]};}
}
export async function createOrmApplication({source,auth,closeResources,...options}:Omit<ApplicationOptions,'database'> & {source:DataSource}){
 try{if(!source.isInitialized)await source.initialize();const database=OrmDatabaseModule.register(source);return await createArticleServer({...options,dependencies:{readiness:database,articles:OrmArticleCore.register(database),auth:OrmAuthCore.register(database,resolveAuthOptions(auth)),comments:OrmCommentsCore.register(database)},closeResources:async signal=>{try{await closeResources?.(signal);}finally{if(source.isInitialized)await source.destroy();}}});}
 catch(error){if(source.isInitialized)await source.destroy();throw error;}
}
