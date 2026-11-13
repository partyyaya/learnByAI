#!/usr/bin/env python3
"""Extract current course examples; do not duplicate production implementations in fixtures."""
from pathlib import Path
import re,shutil
here=Path(__file__).resolve().parent
sources=here/'target/course-tests';resources=here/'target/course-resources'
for path in (sources,resources):
 if path.exists():shutil.rmtree(path)
shutil.copytree(here/'src/test/java',sources);shutil.copytree(here/'src/test/resources',resources)
blocks=[]
for path in sorted(here.parent.glob('[0-9][0-9]-*.md')):
 for match in re.finditer(r'^```([^\n]*)\n(.*?)^```',path.read_text(),re.M|re.S):
  blocks.append((path.name[:2],match[1],match[2]))
def block(ch,needle,lang='java',last=False):
 result=[s for c,l,s in blocks if c==ch and l==lang and needle in s]
 assert result,(ch,needle)
 return result[-1] if last else result[0]
def emit(ch,needle,last=False):
 source=block(ch,needle,last=last)
 package=re.search(r'^package ([\w.]+);',source,re.M).group(1)
 name=re.search(r'^public (?:final |abstract )*(?:class|interface|record) (\w+)',source,re.M).group(1)
 path=sources/package.replace('.','/')/(name+'.java');path.parent.mkdir(parents=True,exist_ok=True);path.write_text(source)
for ch,needle in [('01','public final class ApiErrors'),('02','public interface LocalPasswordPolicy'),('02','public class ShopAuthConfig'),('03','public interface LocalIdentity'),('03','public class ShopMethodSecurityConfig'),('03','public class ShopOrderQueryService'),('03','public class ShopOrder {'),('03','public interface ShopOrderRepo'),('04','public class ShopSessionConfig'),('05','public class ShopUserDetailsService'),('05','public class ShopSessionAdmin'),('05','public class JwtService'),('05','public record JwtPrincipal'),('05','public class JwtAuthenticationFilter'),('05','public interface TokenRevocation'),('05','public class TokenVersionRevocation'),('05','public class RefreshTokenService'),('05','public class ShopTokenConfig'),('05','public class ShopTokenController'),('05','public interface PasswordLoginGate'),('06','public class SocialAccountService'),('06','public class ShopOidcConfig'),('06','public final class ShopOidcUser'),('07','public class ShopLoginProtection'),('07','public class ShopLoginLockoutFilter'),('07','public class ShopWebHardeningConfig'),('08','public class AuditLog'),('08','public class AuditListener'),('08','public class NoteService'),('08','public class NoteChanges'),('08','public class ShopAuditConfig'),('08','public class ShopOrderService'),('08','public class ShopOrderChanges'),('08','public class ShopRefundController')]:emit(ch,needle)
emit('07','public class ShopCorsConfig',last=True)
# Use the actual course schemas; select CREATE statements and remove the lab-specific USE statement.
parts=[block('02','CREATE TABLE app_user (','sql'),block('03','CREATE TABLE app_role (','sql'),block('03','CREATE TABLE shop_order (','sql'),block('05','CREATE TABLE refresh_family (','sql'),block('06','CREATE TABLE social_identity (','sql'),block('08','CREATE TABLE audit_log (','sql')]
(resources/'schema.sql').write_text('\n'.join(re.sub(r'^USE .*?;\s*','',s,flags=re.M) for s in parts))
print('Extracted current Markdown examples and SQL into verification/target')
