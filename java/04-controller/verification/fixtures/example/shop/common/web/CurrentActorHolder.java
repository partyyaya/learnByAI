package example.shop.common.web;
public final class CurrentActorHolder {public static String actorIdOrAnonymous(){var a=org.springframework.security.core.context.SecurityContextHolder.getContext().getAuthentication();return a==null?"anonymous":a.getName();}}
