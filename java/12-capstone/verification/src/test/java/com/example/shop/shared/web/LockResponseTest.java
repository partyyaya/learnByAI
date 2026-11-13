package com.example.shop.shared.web;
import org.junit.jupiter.api.Test;import org.springframework.web.bind.annotation.*;import org.springframework.test.web.servlet.setup.MockMvcBuilders;import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
class LockResponseTest {
 @RestController static class Endpoint {@GetMapping("/lock")String call(){throw new org.springframework.dao.CannotAcquireLockException("SQL secret");}}
 @Test void exhaustedLockConflictReturns503AndRetryAfter()throws Exception{MockMvcBuilders.standaloneSetup(new Endpoint()).setControllerAdvice(new GlobalExceptionHandler()).build().perform(get("/lock")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After","1")).andExpect(jsonPath("$.type").value("/problems/temporarily-unavailable")).andExpect(jsonPath("$.detail").value("系統忙碌中，請稍後再試"));}
}
