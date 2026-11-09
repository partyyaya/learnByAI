package example.shop.chat.web.ws;
public class ChatAccessDeniedException extends RuntimeException {private final String id;public ChatAccessDeniedException(String id,String reason){super(reason);this.id=id;}public String getConversationId(){return id;}}
