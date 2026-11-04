import { Entity,Column,PrimaryColumn,Index,ManyToOne,OneToMany,JoinColumn,Unique,type Relation } from 'typeorm';
import type { ArticleStatus } from '../article-model.js';
import type { Role } from '../auth-model.js';
@Entity('User')
export class UserEntity {
 @PrimaryColumn('text') id!:string;
 @Column('text') displayName!:string;
 @Column('text',{nullable:true,unique:true}) email!:string|null;
 @Column('text',{nullable:true,select:false}) passwordHash!:string|null;
 @Column({type:'enum',enum:['member','admin'],enumName:'UserRole',default:'member'}) role!:Role;
 @OneToMany(()=>ArticleEntity,row=>row.author) articles!:Relation<ArticleEntity[]>;
 @OneToMany(()=>CommentEntity,row=>row.author) comments!:Relation<CommentEntity[]>;
}
@Entity('Session')
@Index(['expiresAt']) @Index(['userId'])
export class SessionEntity {
 @PrimaryColumn({type:'char',length:64}) tokenHash!:string;
 @Column({type:'varchar',length:43}) csrfToken!:string;
 @Column('text',{nullable:true}) userId!:string|null;
 @ManyToOne(()=>UserEntity,{nullable:true,onDelete:'CASCADE'}) @JoinColumn({name:'userId'}) user!:Relation<UserEntity|null>;
 @Column('timestamp with time zone',{precision:3,default:()=> 'CURRENT_TIMESTAMP'}) createdAt!:Date;
 @Column('timestamp with time zone',{precision:3}) expiresAt!:Date;
 @Column('timestamp with time zone',{precision:3,nullable:true}) revokedAt!:Date|null;
}
@Entity('Article')
@Index(['status','createdAt','id']) @Index(['authorId','createdAt','id'])
export class ArticleEntity {
 @PrimaryColumn('text') id!:string;
 @Column('text') authorId!:string;
 @ManyToOne(()=>UserEntity,row=>row.articles,{onDelete:'RESTRICT'}) @JoinColumn({name:'authorId'}) author!:Relation<UserEntity>;
 @Column('text') title!:string;
 @Column('text') content!:string;
 @Column({type:'enum',enum:['draft','published','archived'],enumName:'ArticleStatus',default:'draft'}) status!:ArticleStatus;
 // No @VersionColumn: the actual SQL WHERE and affected count implement the concurrency contract.
 @Column('integer',{default:1}) version!:number;
 @Column('timestamp with time zone',{precision:3,default:()=> 'CURRENT_TIMESTAMP'}) createdAt!:Date;
 @Column('timestamp with time zone',{precision:3}) updatedAt!:Date;
 @OneToMany(()=>CommentEntity,row=>row.article) comments!:Relation<CommentEntity[]>;
}
@Entity('ArticleStatusAudit')
@Unique(['articleId','toVersion']) @Index(['actorId','createdAt'])
export class StatusAuditEntity {
 @PrimaryColumn('text') id!:string;
 @Column('text') articleId!:string;
 @ManyToOne(()=>ArticleEntity,{onDelete:'RESTRICT'}) @JoinColumn({name:'articleId'}) article!:Relation<ArticleEntity>;
 @Column('text') actorId!:string;
 @ManyToOne(()=>UserEntity,{onDelete:'RESTRICT'}) @JoinColumn({name:'actorId'}) actor!:Relation<UserEntity>;
 @Column({type:'enum',enum:['publish','archive'],enumName:'ArticleStatusAction'}) action!:'publish'|'archive';
 @Column({type:'enum',enum:['draft','published','archived'],enumName:'ArticleStatus'}) fromStatus!:ArticleStatus;
 @Column({type:'enum',enum:['draft','published','archived'],enumName:'ArticleStatus'}) toStatus!:ArticleStatus;
 @Column('integer') fromVersion!:number;
 @Column('integer') toVersion!:number;
 @Column('timestamp with time zone',{precision:3,default:()=> 'CURRENT_TIMESTAMP'}) createdAt!:Date;
}
@Entity('Comment') @Index(['articleId','createdAt','id'])
export class CommentEntity {
 @PrimaryColumn('text') id!:string;
 @Column('text') articleId!:string;
 @ManyToOne(()=>ArticleEntity,row=>row.comments,{onDelete:'RESTRICT'}) @JoinColumn({name:'articleId'}) article!:Relation<ArticleEntity>;
 @Column('text') authorId!:string;
 @ManyToOne(()=>UserEntity,row=>row.comments,{onDelete:'RESTRICT'}) @JoinColumn({name:'authorId'}) author!:Relation<UserEntity>;
 @Column('text') content!:string;
 @Column('timestamp with time zone',{precision:3,default:()=> 'CURRENT_TIMESTAMP'}) createdAt!:Date;
}
export const ormEntities=[UserEntity,SessionEntity,ArticleEntity,StatusAuditEntity,CommentEntity];
