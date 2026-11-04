import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ormEntities } from './entities.js';
import { CourseSchema1793664000000 } from './migration.js';
export function createOrmDataSource(connectionString:string){
 const url=new URL(connectionString);if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error('PostgreSQL required');
 const schema=url.searchParams.get('schema')??'public';
 if(url.pathname!=='/course_orm' && !(url.pathname==='/course_test' && /^orm34_[a-f0-9]{32}$/.test(schema)))throw new Error('TypeORM must use its own database or owned test schema');if(!/^[a-z][a-z0-9_]*$/.test(schema))throw new Error('invalid schema');url.searchParams.delete('schema');
 return new DataSource({type:'postgres',url:url.toString(),schema,entities:ormEntities,migrations:[CourseSchema1793664000000],migrationsTableName:'typeorm_migrations',migrationsRun:false,migrationsTransactionMode:'all',synchronize:false,logging:false,extra:{max:5,connectionTimeoutMillis:2000,statement_timeout:5000,options:'-c search_path='+schema}});
}
