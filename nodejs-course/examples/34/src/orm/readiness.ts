import type { DataSource } from 'typeorm';
import { ormEntities } from './entities.js';
export async function checkOrmReady(source:DataSource){
 for(const entity of ormEntities){
  const fields=source.getMetadata(entity).columns.map(column=>'probe.'+column.propertyPath);
  await source.getRepository(entity).createQueryBuilder('probe').select(fields).where('1 = 0').getRawMany();
 }
}
