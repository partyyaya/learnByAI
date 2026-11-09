#!/usr/bin/env python3
"""Extract selected complete teaching classes. Only an explicit list gets compiled; no repository writes outside target/."""
from pathlib import Path
import re, shutil
HERE = Path(__file__).resolve().parent
COURSE = HERE.parent
OUT = HERE / 'target/course-tests'
if OUT.exists(): shutil.rmtree(OUT)
OUT.mkdir(parents=True)

def blocks(chapter):
    return [m.group(1) for m in re.finditer(r'^```[^\n]*\n(.*?)^```\s*$',
            next(COURSE.glob(chapter+'-*.md')).read_text(), re.M | re.S)]

def write_class(source, fallback='example.shop.common.web'):
    if not re.search(r'^package ', source, re.M): source = f'package {fallback};\n' + source
    package = re.search(r'^package ([\w.]+);', source, re.M).group(1)
    name = re.search(r'public\s+(?:(?:abstract|final|sealed)\s+)?(?:class|record|interface|enum)\s+(\w+)', source).group(1)
    path = OUT / package.replace('.', '/') / (name + '.java')
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(source)

SELECT = {
 '01': ['public record OrderFilter(\n', 'public record PageResponse<T>', 'class UnknownQueryParamInterceptor', 'public final class ApiHeaders'],
 '02': ['public @interface SortWhitelist', 'class SortWhitelistValidator'],
 '03': ['public enum ErrorCode', 'abstract class BusinessException', 'record FieldViolation',
        'public record Problem(', 'class ProblemFactory', 'record ApiProblemProperties', 'class ApiErrorController', 'class UnknownParameterException', 'public final class DidYouMean'],
 '04': ['class CachedBodyRequestWrapper', 'class CachedBodyFilter', 'class TraceContext', 'class OncePerRequestInterceptor',
        'public @interface Idempotent', 'interface IdempotencyStore', 'class IdempotencyInterceptor', 'class IdempotencyFilter',
        'class IdempotencyKeyRequiredException', 'class InvalidIdempotencyKeyException', 'class IdempotencyBodyTooLargeException',
        'record FilterProperties(', 'public record AuditEvent('],
 '05': ['class IdempotencyFingerprint', 'class SseEmitterRegistry', 'record SseProperties(',
        'class TooManySseConnectionsException', 'class ExportRetentionSweeper', 'class ImageReencoder', 'class ImageRejectedException', 'public final class ContentTypeDetector'],
 '06': ['public class CorsConfig {\n\n    /**', 'record CorsProperties(', 'public final class ETags', 'public class ProblemWriter'],
 '07': ['class InMemoryIdempotencyStore', 'class RecordingAuditRepository'],
 '08': ['public class StompConfig ', 'class StompAuthChannelInterceptor', 'class SubscriptionAuthorizationInterceptor',
        'class WebSocketSessionRegistry', 'class StompMdcChannelInterceptor', 'record ChatProperties(', 'class StompAuthenticationException']
}
for chapter, needles in SELECT.items():
    available = blocks(chapter)
    for needle in needles:
        matches = [s for s in available if re.search(re.escape(needle) + (r'\b' if needle[-1].isalnum() else ''), s)]
        if len(matches) > 1: matches = [s for s in matches if s.startswith('package ')]
        # FilterProperties intentionally evolves; compile the final complete declaration.
        if needle == 'record FilterProperties(': matches = matches[-1:]
        assert len(matches) == 1, (chapter, needle, len(matches))
        source = matches[0]
        # Java annotation declarations have a distinct token; infer filename explicitly here.
        if 'public @interface ' in source:
            package = re.search(r'^package ([\w.]+);', source, re.M).group(1)
            name = re.search(r'public @interface (\w+)', source).group(1)
            path = OUT/package.replace('.', '/')/(name+'.java');path.parent.mkdir(parents=True,exist_ok=True);path.write_text(source)
        else: write_class(source)

# The binder and the advice override are teaching methods rather than whole classes.
binder = next(s for s in blocks('01') if 'public void preserveRepeatedQueryValues' in s)
write_class('package example.shop.verification;\npublic class QueryBinder {\n'+binder+'\n}')
source = next(s for s in blocks('03') if 'protected ResponseEntity<Object> handleHandlerMethodValidationException' in s)
start = source.index('    @Override\n    protected ResponseEntity<Object> handleHandlerMethodValidationException')
pos = source.index('{', start)+1; depth=1
while depth:
    depth += (source[pos]=='{')-(source[pos]=='}');pos+=1
(HERE/'target/validation-method.txt').write_text(source[start:pos])
# Method tests use a small generated adapter with explicit logging/translation fixtures.
write_class('''package example.shop.verification;
import example.shop.common.web.*;import example.shop.common.error.*;import org.springframework.web.method.annotation.HandlerMethodValidationException;import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;import org.springframework.http.*;import org.springframework.web.context.request.*;import java.util.*;
public class ValidationAdvice extends ResponseEntityExceptionHandler {
 private final ProblemFactory problems; private final ErrorLogger errorLog=new ErrorLogger();
 private final Translation validationErrors=new Translation();
 public ValidationAdvice(ProblemFactory p){problems=p;}
 static class Translation{List<FieldViolation>fromHandlerMethod(HandlerMethodValidationException ex){return List.of();}}
 private String instanceOf(WebRequest r){return "/test";}
 private jakarta.servlet.http.HttpServletRequest servletRequestOf(WebRequest r){return ((ServletWebRequest)r).getRequest();}
 private HttpHeaders problemHeaders(HttpHeaders h){return h;}
 public ResponseEntity<Object> apply(HandlerMethodValidationException ex,WebRequest r){return handleHandlerMethodValidationException(ex,new HttpHeaders(),ex.getStatusCode(),r);}
'''+source[start:pos]+'\n}')
for base in ['fixtures', 'src/test/java']:
    for path in (HERE/base).rglob('*.java'):
        target=OUT/path.relative_to(HERE/base);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
js=next(s for s in blocks('08') if 'async function scheduleReconnect' in s)
(HERE/'target/reconnect.js').write_text(js)
print(f'Prepared {len(list(OUT.rglob("*.java")))} Java sources and reconnect.js')
