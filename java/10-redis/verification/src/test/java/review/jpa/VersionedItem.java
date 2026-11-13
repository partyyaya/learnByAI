package review.jpa;
@jakarta.persistence.Entity
public class VersionedItem {
 @jakarta.persistence.Id public Long id;
 @jakarta.persistence.Version public Long version;
 public String name;
 protected VersionedItem(){}
}
