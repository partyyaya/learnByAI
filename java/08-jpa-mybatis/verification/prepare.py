#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Extract current Markdown examples; fixtures supply only runtime setup and data."""
from pathlib import Path
import re,shutil
here=Path(__file__).resolve().parent
src=here/'target/course-tests';res=here/'target/course-resources'
for p in [src,res]:
 if p.exists():shutil.rmtree(p)
shutil.copytree(here/'src/test/java',src);shutil.copytree(here/'src/test/resources',res)
blocks=[]
for p in sorted(here.parent.glob('[0-9][0-9]-*.md')):
 for m in re.finditer(r'^```([^\n]*)\n(.*?)^```\s*$',p.read_text(),re.M|re.S):
  blocks.append((p.name[:2],m[1],m[2]))
def block(ch,needle,lang='java',package=None):
 found=[s for c,l,s in blocks if c==ch and l==lang and needle in s and (package is None or 'package '+package+';' in s)]
 assert found,(ch,needle)
 return found[0]
def emit(ch,needle,package=None):
 s=block(ch,needle,package=package)
 pkg=re.search(r'^package ([\w.]+);',s,re.M).group(1)
 name=re.search(r'^public (?:final |abstract )*(?:class|record|enum|interface) (\w+)',s,re.M).group(1)
 p=src/pkg.replace('.','/')/(name+'.java');p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s)
for ch,n in [('00','public final class Uuid7'),('00','public class SqlSpy'),('00','public class UuidTypeHandler'),('01','public abstract class BaseEntity'),('01','public enum OrderStatus'),('01','public class Customer extends'),('01','public class Product extends'),('01','public class Order extends'),('01','public class OrderItem extends'),('01','public interface CustomerRepository'),('01','public interface ProductRepository'),('05','public interface OrderRepository'),('03','public record OrderView'),('05','public record OrderListRow'),('06','public class Stock {'),('06','public class InsufficientStockException'),('06','public interface StockRepository'),('06','public class StockService'),('06','public class OrderImportService'),('08','public record OrderSearchCriteria'),('08','public class OrderService'),('08','public record PageResult'),('08','public interface OrderSearchMapper'),('09','public final class OrderSpecifications'),('09','public final class LikePattern'),('09','public class OrderSearchQuery'),('08','public class Dyn'),('08','public final class Pad8'),('07','public class SeqRow'),('07','public interface KeyMapper'),('07','public class KeyBatchService'),('07','public final class VersionWriteGuard'),('08','public final class OptionalPredicateContract'),('08','public final class OrderPageContract'),('08','public final class SafePages')]:
 emit(ch,n,'com.example.lab.shop' if n=='public enum OrderStatus' else None)
(res/'schema.sql').write_text(block('00','CREATE TABLE customer (','sql'))
(res/'OrderSearchMapper.xml').write_text(block('08','<mapper namespace="com.example.lab.shop.mybatis.OrderSearchMapper">','xml'))
s=block('07','<mapper namespace="com.example.lab.shop.mybatis.OrderQueryMapper">','xml')
rm=re.search(r'<resultMap id="listRowMap".*?</resultMap>',s,re.S).group()
(res/'OrderQueryMapper.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "https://mybatis.org/dtd/mybatis-3-mapper.dtd">\n<mapper namespace="com.example.lab.shop.mybatis.OrderQueryMapper">'+rm+'</mapper>')
# Compile the actual chapter-07 read-only boundary method with fixture fields only.
s=block('07','private void assertOnlySelect()')
a=s.index('    private void assertOnlySelect()');b=s.index('\n    }',a)+6
method=s[a:b].replace('private void','public void',1)
p=src/'review/ReadOnlyBoundary.java'
p.write_text('package review;\nimport java.util.List;\npublic class ReadOnlyBoundary {\nfinal org.apache.ibatis.session.SqlSessionFactory sqlSessionFactory;\npublic ReadOnlyBoundary(org.apache.ibatis.session.SqlSessionFactory f){sqlSessionFactory=f;}\n'+method+'\n}')
# The earlier specification is intentionally retained as a negative control (renamed only).
s=block('05','public final class OrderSpecifications').replace('OrderSpecifications','OldOrderSpecifications')
(src/'com/example/lab/shop/OldOrderSpecifications.java').write_text(s)
print('Extracted current Java / SQL examples into verification/target')
