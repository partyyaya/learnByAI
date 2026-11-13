package com.example.toolbox;

import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.github.benmanes.caffeine.cache.*;
import io.github.resilience4j.retry.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.ss.usermodel.*;
import org.javamoney.moneta.Money;
import org.yaml.snakeyaml.error.YAMLException;
import jakarta.validation.Validation;
import java.io.*;
import java.math.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.*;
import java.time.format.DateTimeParseException;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class ToolboxBehaviorTest {
    @TempDir Path temp;

    @Test void invalidDateIsRejectedAndMonthEndPolicyIsExplicit() {
        assertThrows(DateTimeParseException.class,
                () -> LocalDate.parse("2026-02-30", DateTimeExamples.DATE));
        assertEquals(LocalDate.of(2026, 2, 28), DateTimeExamples.nextBillDate(LocalDate.of(2026, 1, 31)));
        assertEquals(LocalDate.of(2026, 3, 28), DateTimeExamples.nextBillDate(LocalDate.of(2026, 2, 28)));
    }

    @Test void minorUnitsFollowCurrencyAndDoNotSilentlyRound() {
        Currency usd = Currency.getInstance("USD"), jpy = Currency.getInstance("JPY");
        assertEquals(new BigDecimal("123.45"), MoneyExamples.fromMinor(12345, usd));
        assertEquals(new BigDecimal("12345"), MoneyExamples.fromMinor(12345, jpy));
        assertEquals(12L, MoneyExamples.toMinor(new BigDecimal("12.00"), jpy));
        assertThrows(ArithmeticException.class, () -> MoneyExamples.toMinor(new BigDecimal("12.345"), usd));
        assertThrows(ArithmeticException.class, () -> MoneyExamples.toMinor(new BigDecimal("9999999999999999999999"), usd));
    }

    @Test void currencyDisplayUsesExplicitCurrencyNotLocaleDefault() {
        String text = MoneyExamples.display(new BigDecimal("123.45"), Currency.getInstance("USD"), Locale.US);
        assertEquals("$123.45", text);
    }

    private ExchangeExamples.Quote quote() {
        Instant time = Instant.parse("2026-11-13T02:00:00Z");
        return new ExchangeExamples.Quote(Currency.getInstance("USD"), Currency.getInstance("TWD"),
                new BigDecimal("32.50"), time, time.plusSeconds(60), "TEST_FIXTURE");
    }

    @Test void exchangeDirectionRoundingAndExpiryArePartOfContract() {
        var quote = quote();
        var now = Clock.fixed(quote.asOf(), ZoneOffset.UTC);
        assertEquals(new BigDecimal("333.13"), ExchangeExamples.convert(
                new BigDecimal("10.25"), Currency.getInstance("USD"), quote, now));
        assertThrows(IllegalArgumentException.class, () -> ExchangeExamples.convert(
                BigDecimal.ONE, Currency.getInstance("EUR"), quote, now));
        assertThrows(IllegalArgumentException.class, () -> ExchangeExamples.convert(
                BigDecimal.ONE, Currency.getInstance("USD"), quote,
                Clock.fixed(quote.validUntil(), ZoneOffset.UTC)));
        assertThrows(IllegalArgumentException.class, () -> ExchangeExamples.convert(
                BigDecimal.ONE, Currency.getInstance("USD"), quote,
                Clock.fixed(quote.asOf().minusSeconds(1), ZoneOffset.UTC)));
    }

    @Test void monetaRejectsAddingDifferentCurrencies() {
        assertThrows(javax.money.MonetaryException.class,
                () -> Money.of(100, "USD").add(Money.of(100, "TWD")));
    }

    @Test void countryCodesAreValidatedSeparatelyFromDisplayLanguage() {
        assertEquals("TW", CountryExamples.region(" tw ").getCountry());
        assertEquals("TWN", CountryExamples.region("TW").getISO3Country());
        assertThrows(IllegalArgumentException.class, () -> CountryExamples.region("ZZ"));
        assertThrows(IllegalArgumentException.class, () -> CountryExamples.region(""));
        assertTrue(CountryExamples.countries(Locale.ENGLISH).stream()
                .anyMatch(c -> c.code().equals("JP") && !c.name().isBlank()));
    }

    @Test void phoneIsNormalisedAndInvalidInputIsRejected() throws Exception {
        assertEquals("+886912345678", PhoneExamples.toE164("0912 345 678", "TW"));
        assertEquals("+886912345678", PhoneExamples.toE164("+886912345678", "US"));
        // 接受國際號碼不等於強制它屬於 defaultRegion；課文有明確說明需另訂政策。
        assertThrows(IllegalArgumentException.class, () -> PhoneExamples.toE164("123", "TW"));
    }

    @Test void unicodeVisibleCharacterCountHandlesCombiningAndJoinedEmoji() {
        assertEquals(1, UnicodeExamples.visibleCharacters("e\u0301"));
        assertEquals(1, UnicodeExamples.visibleCharacters("👨‍👩‍👧‍👦"));
        assertEquals(2, UnicodeExamples.visibleCharacters("台灣"));
        assertEquals(0, UnicodeExamples.visibleCharacters(""));
    }

    @Test void bomIsRemovedAndInputBytesAreBounded() throws Exception {
        Path file = temp.resolve("products.csv");
        Files.writeString(file, "\uFEFFname,price\nBook,100\n", StandardCharsets.UTF_8);
        assertTrue(FileExamples.readUtf8WithoutBom(file).startsWith("name,"));
        Files.write(file, new byte[1024 * 1024 + 1]);
        assertThrows(IOException.class, () -> FileExamples.readUtf8WithoutBom(file));
    }

    @Test void jsonRetainsDecimalAndInstantAndRejectsExtraDocument() throws Exception {
        var view = new JsonExamples.OrderView("O-1", new BigDecimal("123.45"), Instant.parse("2026-11-13T02:00:00Z"));
        String encoded = JsonExamples.JSON.writeValueAsString(view);
        assertEquals(view, JsonExamples.JSON.readValue(encoded, JsonExamples.OrderView.class));
        assertTrue(encoded.contains("2026-11-13T02:00:00Z"));
        assertThrows(JsonProcessingException.class, () -> JsonExamples.JSON.readValue(encoded + " {}", JsonExamples.OrderView.class));
    }

    @Test void csvHandlesQuotedCommaNewlineAndEscapedQuotes() throws Exception {
        String source = "name,price\r\n\"Book, \"\"Java\"\"\nVolume 1\",100.50\r\n";
        var products = CsvExamples.parse(source);
        assertEquals(1, products.size());
        assertEquals("Book, \"Java\"\nVolume 1", products.getFirst().name());
        assertEquals(new BigDecimal("100.50"), products.getFirst().price());
        assertThrows(IllegalArgumentException.class, () -> CsvExamples.parse("name,cost\nBook,100\n"));
        assertThrows(IllegalArgumentException.class, () -> CsvExamples.parse("name,price\nBook,-1\n"));
    }

    @Test void excelPreservesLongLeadingZeroIdAndExactDecimalAsText() throws Exception {
        try (Workbook book = WorkbookFactory.create(new ByteArrayInputStream(ExcelExamples.export()))) {
            Row row = book.getSheetAt(0).getRow(1);
            assertEquals(CellType.STRING, row.getCell(0).getCellType());
            assertEquals("00001234567890123456", row.getCell(0).getStringCellValue());
            assertEquals("1234567890123456.78", row.getCell(1).getStringCellValue());
        }
    }

    @Test void generatedPdfCanBeReopenedAndReceiptTextExtracted() throws Exception {
        try (var document = Loader.loadPDF(PdfExamples.receipt())) {
            assertEquals(1, document.getNumberOfPages());
            assertTrue(new PDFTextStripper().getText(document).contains("Receipt O-001: USD 123.45"));
        }
    }

    @Test void htmlCleaningPreservesAllowedTextAndRemovesScriptsAndEventHandlers() {
        String clean = HtmlExamples.cleanRichText("<b>優惠</b><script>alert(1)</script><img src=x onerror=alert(2)>");
        assertTrue(clean.contains("<b>優惠</b>"));
        assertFalse(clean.contains("script"));
        assertFalse(clean.contains("onerror"));
        assertFalse(clean.contains("alert("));
    }

    @Test void validatorChecksNullAndPatternAndAmountConstraints() {
        try (var factory = Validation.buildDefaultValidatorFactory()) {
            var validator = factory.getValidator();
            assertEquals(0, validator.validate(new ValidationExamples.Signup("demo@example.test", "TW", new BigDecimal("12.34"))).size());
            assertEquals(2, validator.validate(new ValidationExamples.Signup("bad-email", "TW", new BigDecimal("-1"))).size());
            assertEquals(3, validator.validate(new ValidationExamples.Signup(null, "TWN", null)).size());
        }
    }

    @Test void yamlRejectsUnknownKeysBadRangesDuplicatesAndObjectTags() {
        assertEquals(3, ConfigExamples.timeoutSeconds("timeoutSeconds: 3\n"));
        assertThrows(IllegalArgumentException.class, () -> ConfigExamples.timeoutSeconds("timeoutSeconds: 31\n"));
        assertThrows(IllegalArgumentException.class, () -> ConfigExamples.timeoutSeconds("timeoutSeconds: 3\nextra: true\n"));
        assertThrows(YAMLException.class, () -> ConfigExamples.timeoutSeconds("timeoutSeconds: 3\ntimeoutSeconds: 4\n"));
        assertThrows(YAMLException.class, () -> ConfigExamples.timeoutSeconds("!!java.lang.Object {}"));
    }

    @Test void sha256IsKnownDigestAndMappingOmitsSecret() throws Exception {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", EncodingExamples.sha256("abc".getBytes(StandardCharsets.UTF_8)));
        var account = new MappingExamples.Account(1, "demo@example.test", "SECRET_HASH");
        String response = JsonExamples.JSON.writeValueAsString(MappingExamples.toView(account));
        assertFalse(response.contains("SECRET_HASH"));
        assertFalse(response.contains("passwordHash"));
    }
}
