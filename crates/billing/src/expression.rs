use std::collections::HashMap;
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use thiserror::Error;

use crate::{parse_expr_version, split_billing_expr_request_rule, TokenParams};

#[derive(Debug, Error, PartialEq)]
pub enum BillingExprError {
    #[error("expression parse error: {0}")]
    Parse(String),
    #[error("expression runtime error: {0}")]
    Runtime(String),
    #[error("request body is not valid JSON: {0}")]
    InvalidRequestJson(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RequestInput {
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<JsonValue>,
}

impl RequestInput {
    pub fn from_json_body(body: JsonValue) -> Self {
        Self {
            body: Some(body),
            ..Self::default()
        }
    }

    pub fn from_body_slice(body: &[u8]) -> Result<Self, BillingExprError> {
        let body = serde_json::from_slice(body)
            .map_err(|error| BillingExprError::InvalidRequestJson(error.to_string()))?;
        Ok(Self::from_json_body(body))
    }

    pub fn with_headers(mut self, headers: impl IntoIterator<Item = (String, String)>) -> Self {
        self.headers = headers.into_iter().collect();
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TraceResult {
    pub matched_tier: String,
    pub cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExprRun {
    pub cost: f64,
    pub trace: TraceResult,
}

pub fn run_billing_expr(expr: &str, params: TokenParams) -> Result<ExprRun, BillingExprError> {
    run_billing_expr_with_request(expr, params, RequestInput::default())
}

/// Like [`run_billing_expr`] but evaluates time helpers against a pinned
/// `now_unix_seconds` instant (deterministic tests).
pub fn run_billing_expr_at(
    expr: &str,
    params: TokenParams,
    now_unix_seconds: i64,
) -> Result<ExprRun, BillingExprError> {
    run_billing_expr_with_request_at(expr, params, RequestInput::default(), now_unix_seconds)
}

pub fn validate_billing_expr(expr: &str) -> Result<(), BillingExprError> {
    let parts = split_billing_expr_request_rule(expr);
    validate_billing_expr_part(&parts.billing_expr)?;
    if let Some(request_rule_expr) = parts.request_rule_expr {
        validate_billing_expr_part(&request_rule_expr)?;
    }
    Ok(())
}

/// Current Unix time in seconds (UTC). Used as the default clock for the
/// time helpers when no pinned instant is supplied.
fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub fn run_billing_expr_with_request(
    expr: &str,
    params: TokenParams,
    request: RequestInput,
) -> Result<ExprRun, BillingExprError> {
    run_billing_expr_with_request_at(expr, params, request, current_unix_seconds())
}

/// Like [`run_billing_expr_with_request`] but evaluates time helpers
/// (`hour`/`minute`/...) against a pinned `now_unix_seconds` instant, enabling
/// deterministic tests of time-based billing expressions (night discounts,
/// weekday/month-day tiers). Production callers use
/// [`run_billing_expr_with_request`], which passes the wall clock.
pub fn run_billing_expr_with_request_at(
    expr: &str,
    params: TokenParams,
    request: RequestInput,
    now_unix_seconds: i64,
) -> Result<ExprRun, BillingExprError> {
    let parts = split_billing_expr_request_rule(expr);
    let base_run = run_billing_expr_part(
        &parts.billing_expr,
        params,
        request.clone(),
        now_unix_seconds,
    )?;
    let Some(request_rule_expr) = parts.request_rule_expr else {
        return Ok(base_run);
    };
    let multiplier_run =
        run_billing_expr_part(&request_rule_expr, params, request, now_unix_seconds)?;
    Ok(ExprRun {
        cost: base_run.cost * multiplier_run.cost,
        trace: base_run.trace,
    })
}

fn run_billing_expr_part(
    expr: &str,
    params: TokenParams,
    request: RequestInput,
    now_unix_seconds: i64,
) -> Result<ExprRun, BillingExprError> {
    let (_, body) = parse_expr_version(expr);
    let tokens = Lexer::new(body).lex()?;
    let ast = Parser::new(tokens).parse()?;
    let mut evaluator = Evaluator::new(params, request, now_unix_seconds);
    let value = evaluator.eval(&ast)?;
    let cost = value.as_number("expression result")?;
    Ok(ExprRun {
        cost,
        trace: evaluator.trace,
    })
}

fn validate_billing_expr_part(expr: &str) -> Result<(), BillingExprError> {
    let (_, body) = parse_expr_version(expr);
    let tokens = Lexer::new(body).lex()?;
    let ast = Parser::new(tokens).parse()?;
    validate_expr_ast(&ast)
}

fn validate_expr_ast(expr: &Expr) -> Result<(), BillingExprError> {
    match expr {
        Expr::Number(_) | Expr::String(_) | Expr::Bool(_) | Expr::Null => Ok(()),
        Expr::Variable(name) => {
            if known_variable(name) {
                Ok(())
            } else {
                Err(BillingExprError::Parse(format!(
                    "unknown identifier {name:?}"
                )))
            }
        }
        Expr::Unary { expr, .. } => validate_expr_ast(expr),
        Expr::Binary { left, right, .. } => {
            validate_expr_ast(left)?;
            validate_expr_ast(right)
        }
        Expr::Conditional {
            condition,
            then_branch,
            else_branch,
        } => {
            validate_expr_ast(condition)?;
            validate_expr_ast(then_branch)?;
            validate_expr_ast(else_branch)
        }
        Expr::Call { name, args } => {
            let Some(expected) = known_function_arg_count(name) else {
                return Err(BillingExprError::Parse(format!(
                    "unknown function {name:?}"
                )));
            };
            if args.len() != expected {
                return Err(BillingExprError::Parse(format!(
                    "{name} expects {expected} argument(s), got {}",
                    args.len()
                )));
            }
            for arg in args {
                validate_expr_ast(arg)?;
            }
            Ok(())
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Number(f64),
    String(String),
    Identifier(String),
    Plus,
    Minus,
    Star,
    Slash,
    LParen,
    RParen,
    Comma,
    Question,
    Colon,
    Bang,
    EqEq,
    BangEq,
    Lt,
    LtEq,
    Gt,
    GtEq,
    AndAnd,
    OrOr,
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
struct Token {
    kind: TokenKind,
    offset: usize,
}

struct Lexer<'a> {
    input: &'a str,
    chars: Vec<char>,
    index: usize,
}

impl<'a> Lexer<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            input,
            chars: input.chars().collect(),
            index: 0,
        }
    }

    fn lex(mut self) -> Result<Vec<Token>, BillingExprError> {
        let mut tokens = Vec::new();
        while let Some(ch) = self.peek() {
            let offset = self.index;
            match ch {
                ' ' | '\t' | '\r' | '\n' => {
                    self.advance();
                }
                '0'..='9' => tokens.push(self.lex_number()?),
                '.' if self.peek_next().is_some_and(|next| next.is_ascii_digit()) => {
                    tokens.push(self.lex_number()?)
                }
                '"' | '\'' => tokens.push(self.lex_string(ch, false)?),
                '`' => tokens.push(self.lex_string(ch, true)?),
                '+' => {
                    self.advance();
                    tokens.push(Token {
                        kind: TokenKind::Plus,
                        offset,
                    });
                }
                '-' => {
                    self.advance();
                    tokens.push(Token {
                        kind: TokenKind::Minus,
                        offset,
                    });
                }
                '*' => {
                    self.advance();
                    tokens.push(Token {
                        kind: TokenKind::Star,
                        offset,
                    });
                }
                '/' => {
                    self.advance();
                    tokens.push(Token {
                        kind: TokenKind::Slash,
                        offset,
                    });
                }
                '(' => {
                    self.advance();
                    tokens.push(Token {
                        kind: TokenKind::LParen,
                        offset,
                    });
                }
                ')' => {
                    self.advance();
                    tokens.push(Token {
                        kind: TokenKind::RParen,
                        offset,
                    });
                }
                ',' => {
                    self.advance();
                    tokens.push(Token {
                        kind: TokenKind::Comma,
                        offset,
                    });
                }
                '?' => {
                    self.advance();
                    tokens.push(Token {
                        kind: TokenKind::Question,
                        offset,
                    });
                }
                ':' => {
                    self.advance();
                    tokens.push(Token {
                        kind: TokenKind::Colon,
                        offset,
                    });
                }
                '!' => {
                    self.advance();
                    let kind = if self.match_char('=') {
                        TokenKind::BangEq
                    } else {
                        TokenKind::Bang
                    };
                    tokens.push(Token { kind, offset });
                }
                '=' => {
                    self.advance();
                    if self.match_char('=') {
                        tokens.push(Token {
                            kind: TokenKind::EqEq,
                            offset,
                        });
                    } else {
                        return Err(BillingExprError::Parse(format!(
                            "unexpected '=' at byte {offset}; use '==' for equality"
                        )));
                    }
                }
                '<' => {
                    self.advance();
                    let kind = if self.match_char('=') {
                        TokenKind::LtEq
                    } else {
                        TokenKind::Lt
                    };
                    tokens.push(Token { kind, offset });
                }
                '>' => {
                    self.advance();
                    let kind = if self.match_char('=') {
                        TokenKind::GtEq
                    } else {
                        TokenKind::Gt
                    };
                    tokens.push(Token { kind, offset });
                }
                '&' => {
                    self.advance();
                    if self.match_char('&') {
                        tokens.push(Token {
                            kind: TokenKind::AndAnd,
                            offset,
                        });
                    } else {
                        return Err(BillingExprError::Parse(format!(
                            "unexpected '&' at byte {offset}; use '&&'"
                        )));
                    }
                }
                '|' => {
                    self.advance();
                    if self.match_char('|') {
                        tokens.push(Token {
                            kind: TokenKind::OrOr,
                            offset,
                        });
                    } else {
                        return Err(BillingExprError::Parse(format!(
                            "unexpected '|' at byte {offset}; use '||'"
                        )));
                    }
                }
                _ if is_identifier_start(ch) => tokens.push(self.lex_identifier()),
                _ => {
                    return Err(BillingExprError::Parse(format!(
                        "unexpected character {ch:?} at byte {offset}"
                    )));
                }
            }
        }
        tokens.push(Token {
            kind: TokenKind::Eof,
            offset: self.input.len(),
        });
        Ok(tokens)
    }

    fn lex_number(&mut self) -> Result<Token, BillingExprError> {
        let start = self.index;
        while self.peek().is_some_and(|ch| ch.is_ascii_digit()) {
            self.advance();
        }
        if self.peek() == Some('.') {
            self.advance();
            while self.peek().is_some_and(|ch| ch.is_ascii_digit()) {
                self.advance();
            }
        }
        if self.peek().is_some_and(|ch| ch == 'e' || ch == 'E') {
            self.advance();
            if self.peek().is_some_and(|ch| ch == '+' || ch == '-') {
                self.advance();
            }
            let exponent_start = self.index;
            while self.peek().is_some_and(|ch| ch.is_ascii_digit()) {
                self.advance();
            }
            if exponent_start == self.index {
                return Err(BillingExprError::Parse(format!(
                    "missing exponent digits at byte {}",
                    self.index
                )));
            }
        }
        let literal: String = self.chars[start..self.index].iter().collect();
        let number = literal.parse::<f64>().map_err(|error| {
            BillingExprError::Parse(format!("invalid number {literal:?}: {error}"))
        })?;
        Ok(Token {
            kind: TokenKind::Number(number),
            offset: start,
        })
    }

    fn lex_string(&mut self, quote: char, raw: bool) -> Result<Token, BillingExprError> {
        let offset = self.index;
        self.advance();
        let mut value = String::new();
        while let Some(ch) = self.peek() {
            self.advance();
            if ch == quote {
                return Ok(Token {
                    kind: TokenKind::String(value),
                    offset,
                });
            }
            if raw {
                value.push(ch);
                continue;
            }
            if ch == '\\' {
                let escaped = self.peek().ok_or_else(|| {
                    BillingExprError::Parse(format!("unterminated escape at byte {}", self.index))
                })?;
                self.advance();
                match escaped {
                    'n' => value.push('\n'),
                    'r' => value.push('\r'),
                    't' => value.push('\t'),
                    '\\' => value.push('\\'),
                    '"' => value.push('"'),
                    '\'' => value.push('\''),
                    other => value.push(other),
                }
            } else {
                value.push(ch);
            }
        }
        Err(BillingExprError::Parse(format!(
            "unterminated string starting at byte {offset}"
        )))
    }

    fn lex_identifier(&mut self) -> Token {
        let start = self.index;
        self.advance();
        while self.peek().is_some_and(is_identifier_continue) {
            self.advance();
        }
        let name: String = self.chars[start..self.index].iter().collect();
        Token {
            kind: TokenKind::Identifier(name),
            offset: start,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.index).copied()
    }

    fn peek_next(&self) -> Option<char> {
        self.chars.get(self.index + 1).copied()
    }

    fn advance(&mut self) {
        self.index += 1;
    }

    fn match_char(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.advance();
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Expr {
    Number(f64),
    String(String),
    Bool(bool),
    Null,
    Variable(String),
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Conditional {
        condition: Box<Expr>,
        then_branch: Box<Expr>,
        else_branch: Box<Expr>,
    },
    Call {
        name: String,
        args: Vec<Expr>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnaryOp {
    Not,
    Negate,
    Plus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BinaryOp {
    Add,
    Subtract,
    Multiply,
    Divide,
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    And,
    Or,
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, index: 0 }
    }

    fn parse(mut self) -> Result<Expr, BillingExprError> {
        let expr = self.parse_expression()?;
        if !matches!(self.peek().kind, TokenKind::Eof) {
            return Err(self.parse_error("unexpected trailing tokens"));
        }
        Ok(expr)
    }

    fn parse_expression(&mut self) -> Result<Expr, BillingExprError> {
        self.parse_conditional()
    }

    fn parse_conditional(&mut self) -> Result<Expr, BillingExprError> {
        let condition = self.parse_or()?;
        if self.matches_kind(&TokenKind::Question) {
            let then_branch = self.parse_expression()?;
            self.expect(&TokenKind::Colon, "expected ':' in conditional expression")?;
            let else_branch = self.parse_expression()?;
            Ok(Expr::Conditional {
                condition: Box::new(condition),
                then_branch: Box::new(then_branch),
                else_branch: Box::new(else_branch),
            })
        } else {
            Ok(condition)
        }
    }

    fn parse_or(&mut self) -> Result<Expr, BillingExprError> {
        let mut expr = self.parse_and()?;
        while self.matches_kind(&TokenKind::OrOr) {
            let right = self.parse_and()?;
            expr = Expr::Binary {
                op: BinaryOp::Or,
                left: Box::new(expr),
                right: Box::new(right),
            };
        }
        Ok(expr)
    }

    fn parse_and(&mut self) -> Result<Expr, BillingExprError> {
        let mut expr = self.parse_equality()?;
        while self.matches_kind(&TokenKind::AndAnd) {
            let right = self.parse_equality()?;
            expr = Expr::Binary {
                op: BinaryOp::And,
                left: Box::new(expr),
                right: Box::new(right),
            };
        }
        Ok(expr)
    }

    fn parse_equality(&mut self) -> Result<Expr, BillingExprError> {
        let mut expr = self.parse_comparison()?;
        loop {
            let op = if self.matches_kind(&TokenKind::EqEq) {
                Some(BinaryOp::Equal)
            } else if self.matches_kind(&TokenKind::BangEq) {
                Some(BinaryOp::NotEqual)
            } else {
                None
            };
            if let Some(op) = op {
                let right = self.parse_comparison()?;
                expr = Expr::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(right),
                };
            } else {
                return Ok(expr);
            }
        }
    }

    fn parse_comparison(&mut self) -> Result<Expr, BillingExprError> {
        let mut expr = self.parse_term()?;
        loop {
            let op = if self.matches_kind(&TokenKind::Lt) {
                Some(BinaryOp::Less)
            } else if self.matches_kind(&TokenKind::LtEq) {
                Some(BinaryOp::LessEqual)
            } else if self.matches_kind(&TokenKind::Gt) {
                Some(BinaryOp::Greater)
            } else if self.matches_kind(&TokenKind::GtEq) {
                Some(BinaryOp::GreaterEqual)
            } else {
                None
            };
            if let Some(op) = op {
                let right = self.parse_term()?;
                expr = Expr::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(right),
                };
            } else {
                return Ok(expr);
            }
        }
    }

    fn parse_term(&mut self) -> Result<Expr, BillingExprError> {
        let mut expr = self.parse_factor()?;
        loop {
            let op = if self.matches_kind(&TokenKind::Plus) {
                Some(BinaryOp::Add)
            } else if self.matches_kind(&TokenKind::Minus) {
                Some(BinaryOp::Subtract)
            } else {
                None
            };
            if let Some(op) = op {
                let right = self.parse_factor()?;
                expr = Expr::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(right),
                };
            } else {
                return Ok(expr);
            }
        }
    }

    fn parse_factor(&mut self) -> Result<Expr, BillingExprError> {
        let mut expr = self.parse_unary()?;
        loop {
            let op = if self.matches_kind(&TokenKind::Star) {
                Some(BinaryOp::Multiply)
            } else if self.matches_kind(&TokenKind::Slash) {
                Some(BinaryOp::Divide)
            } else {
                None
            };
            if let Some(op) = op {
                let right = self.parse_unary()?;
                expr = Expr::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(right),
                };
            } else {
                return Ok(expr);
            }
        }
    }

    fn parse_unary(&mut self) -> Result<Expr, BillingExprError> {
        if self.matches_kind(&TokenKind::Bang) {
            return Ok(Expr::Unary {
                op: UnaryOp::Not,
                expr: Box::new(self.parse_unary()?),
            });
        }
        if self.matches_kind(&TokenKind::Minus) {
            return Ok(Expr::Unary {
                op: UnaryOp::Negate,
                expr: Box::new(self.parse_unary()?),
            });
        }
        if self.matches_kind(&TokenKind::Plus) {
            return Ok(Expr::Unary {
                op: UnaryOp::Plus,
                expr: Box::new(self.parse_unary()?),
            });
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, BillingExprError> {
        let token = self.advance().clone();
        match token.kind {
            TokenKind::Number(number) => Ok(Expr::Number(number)),
            TokenKind::String(value) => Ok(Expr::String(value)),
            TokenKind::Identifier(name) => match name.as_str() {
                "true" => Ok(Expr::Bool(true)),
                "false" => Ok(Expr::Bool(false)),
                "nil" | "null" => Ok(Expr::Null),
                _ if self.matches_kind(&TokenKind::LParen) => {
                    let mut args = Vec::new();
                    if !matches!(self.peek().kind, TokenKind::RParen) {
                        loop {
                            args.push(self.parse_expression()?);
                            if !self.matches_kind(&TokenKind::Comma) {
                                break;
                            }
                        }
                    }
                    self.expect(&TokenKind::RParen, "expected ')' after function arguments")?;
                    Ok(Expr::Call { name, args })
                }
                _ => Ok(Expr::Variable(name)),
            },
            TokenKind::LParen => {
                let expr = self.parse_expression()?;
                self.expect(&TokenKind::RParen, "expected ')' after expression")?;
                Ok(expr)
            }
            _ => Err(BillingExprError::Parse(format!(
                "expected expression at byte {}",
                token.offset
            ))),
        }
    }

    fn expect(&mut self, expected: &TokenKind, message: &str) -> Result<(), BillingExprError> {
        if self.matches_kind(expected) {
            Ok(())
        } else {
            Err(self.parse_error(message))
        }
    }

    fn matches_kind(&mut self, expected: &TokenKind) -> bool {
        if same_token_variant(&self.peek().kind, expected) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn advance(&mut self) -> &Token {
        let index = self.index;
        if !matches!(self.tokens[index].kind, TokenKind::Eof) {
            self.index += 1;
        }
        &self.tokens[index]
    }

    fn peek(&self) -> &Token {
        self.tokens
            .get(self.index)
            .unwrap_or_else(|| self.tokens.last().expect("lexer always emits eof"))
    }

    fn parse_error(&self, message: &str) -> BillingExprError {
        BillingExprError::Parse(format!("{message} at byte {}", self.peek().offset))
    }
}

fn same_token_variant(left: &TokenKind, right: &TokenKind) -> bool {
    std::mem::discriminant(left) == std::mem::discriminant(right)
}

#[derive(Debug, Clone, PartialEq)]
enum ExprValue {
    Number(f64),
    Bool(bool),
    String(String),
    Null,
}

impl ExprValue {
    fn as_number(&self, label: &str) -> Result<f64, BillingExprError> {
        match self {
            Self::Number(number) => Ok(*number),
            other => Err(BillingExprError::Runtime(format!(
                "{label} is {other}, expected number"
            ))),
        }
    }

    fn as_bool(&self, label: &str) -> Result<bool, BillingExprError> {
        match self {
            Self::Bool(value) => Ok(*value),
            other => Err(BillingExprError::Runtime(format!(
                "{label} is {other}, expected boolean"
            ))),
        }
    }

    fn as_string(&self, label: &str) -> Result<&str, BillingExprError> {
        match self {
            Self::String(value) => Ok(value),
            other => Err(BillingExprError::Runtime(format!(
                "{label} is {other}, expected string"
            ))),
        }
    }
}

impl fmt::Display for ExprValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number(number) => write!(f, "{number}"),
            Self::Bool(value) => write!(f, "{value}"),
            Self::String(value) => f.write_str(value),
            Self::Null => f.write_str("nil"),
        }
    }
}

struct Evaluator {
    params: TokenParams,
    request: RequestInput,
    normalized_headers: HashMap<String, String>,
    trace: TraceResult,
    /// Pinned Unix-seconds instant used by the time helpers (`hour`, `minute`,
    /// ...). Threaded in from the entry point so tests can evaluate time-based
    /// expressions deterministically instead of reading `SystemTime::now()`.
    now_unix_seconds: i64,
}

impl Evaluator {
    fn new(params: TokenParams, request: RequestInput, now_unix_seconds: i64) -> Self {
        let normalized_headers = normalize_headers(&request.headers);
        Self {
            params,
            request,
            normalized_headers,
            trace: TraceResult::default(),
            now_unix_seconds,
        }
    }

    fn eval(&mut self, expr: &Expr) -> Result<ExprValue, BillingExprError> {
        match expr {
            Expr::Number(number) => Ok(ExprValue::Number(*number)),
            Expr::String(value) => Ok(ExprValue::String(value.clone())),
            Expr::Bool(value) => Ok(ExprValue::Bool(*value)),
            Expr::Null => Ok(ExprValue::Null),
            Expr::Variable(name) => self.eval_variable(name),
            Expr::Unary { op, expr } => self.eval_unary(*op, expr),
            Expr::Binary { op, left, right } => self.eval_binary(*op, left, right),
            Expr::Conditional {
                condition,
                then_branch,
                else_branch,
            } => {
                if self.eval(condition)?.as_bool("conditional condition")? {
                    self.eval(then_branch)
                } else {
                    self.eval(else_branch)
                }
            }
            Expr::Call { name, args } => self.eval_call(name, args),
        }
    }

    fn eval_variable(&self, name: &str) -> Result<ExprValue, BillingExprError> {
        let number = match name {
            "p" => self.params.p,
            "c" => self.params.c,
            "len" => self.params.len,
            "cr" => self.params.cr,
            "cc" => self.params.cc,
            "cc1h" => self.params.cc1h,
            "img" => self.params.img,
            "img_o" => self.params.img_o,
            "ai" => self.params.ai,
            "ao" => self.params.ao,
            _ if !known_variable(name) => {
                return Err(BillingExprError::Runtime(format!(
                    "unknown identifier {name:?}"
                )));
            }
            _ => unreachable!("known variable table and evaluator match arms diverged"),
        };
        Ok(ExprValue::Number(number))
    }

    fn eval_unary(&mut self, op: UnaryOp, expr: &Expr) -> Result<ExprValue, BillingExprError> {
        let value = self.eval(expr)?;
        match op {
            UnaryOp::Not => Ok(ExprValue::Bool(!value.as_bool("unary operand")?)),
            UnaryOp::Negate => Ok(ExprValue::Number(-value.as_number("unary operand")?)),
            UnaryOp::Plus => Ok(ExprValue::Number(value.as_number("unary operand")?)),
        }
    }

    fn eval_binary(
        &mut self,
        op: BinaryOp,
        left: &Expr,
        right: &Expr,
    ) -> Result<ExprValue, BillingExprError> {
        if op == BinaryOp::And {
            let left = self.eval(left)?.as_bool("left operand")?;
            if !left {
                return Ok(ExprValue::Bool(false));
            }
            return Ok(ExprValue::Bool(self.eval(right)?.as_bool("right operand")?));
        }
        if op == BinaryOp::Or {
            let left = self.eval(left)?.as_bool("left operand")?;
            if left {
                return Ok(ExprValue::Bool(true));
            }
            return Ok(ExprValue::Bool(self.eval(right)?.as_bool("right operand")?));
        }

        let left = self.eval(left)?;
        let right = self.eval(right)?;
        match op {
            BinaryOp::Add => Ok(ExprValue::Number(
                left.as_number("left operand")? + right.as_number("right operand")?,
            )),
            BinaryOp::Subtract => Ok(ExprValue::Number(
                left.as_number("left operand")? - right.as_number("right operand")?,
            )),
            BinaryOp::Multiply => Ok(ExprValue::Number(
                left.as_number("left operand")? * right.as_number("right operand")?,
            )),
            BinaryOp::Divide => Ok(ExprValue::Number(
                left.as_number("left operand")? / right.as_number("right operand")?,
            )),
            BinaryOp::Equal => Ok(ExprValue::Bool(values_equal(&left, &right))),
            BinaryOp::NotEqual => Ok(ExprValue::Bool(!values_equal(&left, &right))),
            BinaryOp::Less => Ok(ExprValue::Bool(
                left.as_number("left operand")? < right.as_number("right operand")?,
            )),
            BinaryOp::LessEqual => Ok(ExprValue::Bool(
                left.as_number("left operand")? <= right.as_number("right operand")?,
            )),
            BinaryOp::Greater => Ok(ExprValue::Bool(
                left.as_number("left operand")? > right.as_number("right operand")?,
            )),
            BinaryOp::GreaterEqual => Ok(ExprValue::Bool(
                left.as_number("left operand")? >= right.as_number("right operand")?,
            )),
            BinaryOp::And | BinaryOp::Or => unreachable!("logical operators short-circuit above"),
        }
    }

    fn eval_call(&mut self, name: &str, args: &[Expr]) -> Result<ExprValue, BillingExprError> {
        match name {
            "tier" => {
                self.expect_arg_count(name, args, 2)?;
                let tier_name = self.eval(&args[0])?.as_string("tier name")?.to_string();
                let value = self.eval(&args[1])?.as_number("tier value")?;
                self.trace.matched_tier = tier_name;
                self.trace.cost = value;
                Ok(ExprValue::Number(value))
            }
            "param" => {
                self.expect_arg_count(name, args, 1)?;
                let path = self.eval(&args[0])?.as_string("param path")?.to_string();
                Ok(self.param(&path))
            }
            "header" => {
                self.expect_arg_count(name, args, 1)?;
                let raw_key = self.eval(&args[0])?;
                let key = normalize_header_key(raw_key.as_string("header key")?);
                Ok(ExprValue::String(
                    self.normalized_headers
                        .get(&key)
                        .cloned()
                        .unwrap_or_default(),
                ))
            }
            "has" => {
                self.expect_arg_count(name, args, 2)?;
                let source = self.eval(&args[0])?;
                let substr = self.eval(&args[1])?.as_string("substring")?.to_string();
                let matched = !matches!(source, ExprValue::Null)
                    && !substr.is_empty()
                    && source.to_string().contains(&substr);
                Ok(ExprValue::Bool(matched))
            }
            "hour" => self.time_part(name, args, |parts| parts.hour),
            "minute" => self.time_part(name, args, |parts| parts.minute),
            "weekday" => self.time_part(name, args, |parts| parts.weekday),
            "month" => self.time_part(name, args, |parts| parts.month),
            "day" => self.time_part(name, args, |parts| parts.day),
            "max" => self.numeric_binary_function(name, args, f64::max),
            "min" => self.numeric_binary_function(name, args, f64::min),
            "abs" => self.numeric_unary_function(name, args, f64::abs),
            "ceil" => self.numeric_unary_function(name, args, f64::ceil),
            "floor" => self.numeric_unary_function(name, args, f64::floor),
            _ if known_function_arg_count(name).is_none() => Err(BillingExprError::Runtime(
                format!("unknown function {name:?}"),
            )),
            _ => unreachable!("known function table and evaluator match arms diverged"),
        }
    }

    fn param(&self, path: &str) -> ExprValue {
        let Some(body) = &self.request.body else {
            return ExprValue::Null;
        };
        let path = path.trim();
        if path.is_empty() {
            return ExprValue::Null;
        }
        let mut current = body;
        for segment in path.split('.') {
            if segment.is_empty() {
                return ExprValue::Null;
            }
            if segment == "#" {
                if let JsonValue::Array(items) = current {
                    return ExprValue::Number(items.len() as f64);
                }
                return ExprValue::Null;
            }
            match current {
                JsonValue::Object(map) => {
                    let Some(next) = map.get(segment) else {
                        return ExprValue::Null;
                    };
                    current = next;
                }
                JsonValue::Array(items) => {
                    let Ok(index) = segment.parse::<usize>() else {
                        return ExprValue::Null;
                    };
                    let Some(next) = items.get(index) else {
                        return ExprValue::Null;
                    };
                    current = next;
                }
                _ => return ExprValue::Null,
            }
        }
        json_to_expr_value(current)
    }

    fn time_part(
        &mut self,
        name: &str,
        args: &[Expr],
        pick: impl FnOnce(TimeParts) -> i64,
    ) -> Result<ExprValue, BillingExprError> {
        self.expect_arg_count(name, args, 1)?;
        let tz = self.eval(&args[0])?.as_string("timezone")?.to_string();
        Ok(ExprValue::Number(
            pick(time_parts(&tz, self.now_unix_seconds)) as f64,
        ))
    }

    fn numeric_binary_function(
        &mut self,
        name: &str,
        args: &[Expr],
        function: fn(f64, f64) -> f64,
    ) -> Result<ExprValue, BillingExprError> {
        self.expect_arg_count(name, args, 2)?;
        let left = self.eval(&args[0])?.as_number("first argument")?;
        let right = self.eval(&args[1])?.as_number("second argument")?;
        Ok(ExprValue::Number(function(left, right)))
    }

    fn numeric_unary_function(
        &mut self,
        name: &str,
        args: &[Expr],
        function: fn(f64) -> f64,
    ) -> Result<ExprValue, BillingExprError> {
        self.expect_arg_count(name, args, 1)?;
        let value = self.eval(&args[0])?.as_number("argument")?;
        Ok(ExprValue::Number(function(value)))
    }

    fn expect_arg_count(
        &self,
        name: &str,
        args: &[Expr],
        expected: usize,
    ) -> Result<(), BillingExprError> {
        if args.len() == expected {
            Ok(())
        } else {
            Err(BillingExprError::Runtime(format!(
                "{name} expects {expected} argument(s), got {}",
                args.len()
            )))
        }
    }
}

fn values_equal(left: &ExprValue, right: &ExprValue) -> bool {
    match (left, right) {
        (ExprValue::Number(left), ExprValue::Number(right)) => {
            (*left - *right).abs() < f64::EPSILON
        }
        (ExprValue::Bool(left), ExprValue::Bool(right)) => left == right,
        (ExprValue::String(left), ExprValue::String(right)) => left == right,
        (ExprValue::Null, ExprValue::Null) => true,
        _ => false,
    }
}

fn json_to_expr_value(value: &JsonValue) -> ExprValue {
    match value {
        JsonValue::Null => ExprValue::Null,
        JsonValue::Bool(value) => ExprValue::Bool(*value),
        JsonValue::Number(value) => value
            .as_f64()
            .map(ExprValue::Number)
            .unwrap_or(ExprValue::Null),
        JsonValue::String(value) => ExprValue::String(value.clone()),
        JsonValue::Array(_) | JsonValue::Object(_) => ExprValue::String(value.to_string()),
    }
}

fn normalize_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    let mut normalized = HashMap::with_capacity(headers.len());
    for (key, value) in headers {
        let key = normalize_header_key(key);
        let value = value.trim();
        if !key.is_empty() && !value.is_empty() {
            normalized.insert(key, value.to_string());
        }
    }
    normalized
}

fn normalize_header_key(key: &str) -> String {
    key.trim().to_ascii_lowercase()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TimeParts {
    hour: i64,
    minute: i64,
    weekday: i64,
    month: i64,
    day: i64,
}

fn time_parts(timezone: &str, now_unix_seconds: i64) -> TimeParts {
    let offset_seconds = timezone_offset_seconds(timezone);
    let now = now_unix_seconds + offset_seconds;
    let days = now.div_euclid(86_400);
    let seconds_in_day = now.rem_euclid(86_400);
    let (_, month, day) = civil_from_days(days);
    TimeParts {
        hour: seconds_in_day / 3_600,
        minute: (seconds_in_day % 3_600) / 60,
        weekday: (days + 4).rem_euclid(7),
        month: month as i64,
        day: day as i64,
    }
}

fn timezone_offset_seconds(timezone: &str) -> i64 {
    match timezone.trim() {
        "Asia/Shanghai" | "Asia/Singapore" | "Asia/Hong_Kong" | "Asia/Taipei" => 8 * 3_600,
        "Asia/Tokyo" | "Asia/Seoul" => 9 * 3_600,
        "Australia/Sydney" => 10 * 3_600,
        "Europe/Berlin" => 3_600,
        "America/New_York" => -5 * 3_600,
        "America/Chicago" => -6 * 3_600,
        "America/Los_Angeles" => -8 * 3_600,
        "UTC" | "Etc/UTC" | "GMT" | "" => 0,
        "Europe/London" => 0,
        _ => 0,
    }
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let days = days + 719_468;
    let era = (if days >= 0 { days } else { days - 146_096 }) / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month as u32, day as u32)
}

fn is_identifier_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_identifier_continue(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn known_variable(name: &str) -> bool {
    matches!(
        name,
        "p" | "c" | "len" | "cr" | "cc" | "cc1h" | "img" | "img_o" | "ai" | "ao"
    )
}

fn known_function_arg_count(name: &str) -> Option<usize> {
    match name {
        "tier" => Some(2),
        "param" | "header" | "hour" | "minute" | "weekday" | "month" | "day" | "abs" | "ceil"
        | "floor" => Some(1),
        "has" | "max" | "min" => Some(2),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;

    fn run(expr: &str, params: TokenParams) -> ExprRun {
        run_billing_expr(expr, params).expect("expression should run")
    }

    #[test]
    fn runs_simple_flat_expression_without_tier() {
        let output = run(
            "p * 0.5 + c * 1.0",
            TokenParams {
                p: 1_000.0,
                c: 500.0,
                ..TokenParams::default()
            },
        );

        assert_eq!(output.cost, 1_000.0);
        assert_eq!(output.trace.matched_tier, "");
        assert_eq!(output.trace.cost, 0.0);
    }

    #[test]
    fn records_selected_tier_from_conditional_branch() {
        let expr = r#"len <= 200000 ? tier("standard", p * 3 + c * 15) : tier("long_context", p * 6 + c * 22.5)"#;

        let standard = run(
            expr,
            TokenParams {
                p: 100_000.0,
                c: 1_000.0,
                len: 200_000.0,
                ..TokenParams::default()
            },
        );
        assert_eq!(standard.trace.matched_tier, "standard");
        assert_eq!(standard.cost, 315_000.0);

        let long_context = run(
            expr,
            TokenParams {
                p: 100_000.0,
                c: 1_000.0,
                len: 200_001.0,
                ..TokenParams::default()
            },
        );
        assert_eq!(long_context.trace.matched_tier, "long_context");
        assert_eq!(long_context.cost, 622_500.0);
    }

    #[test]
    fn supports_multicondition_logical_tiers() {
        let expr = r#"
            p < 32000 && c < 200 ? tier("tier1_short", p * 2 + c * 8) :
            p < 32000 && c >= 200 ? tier("tier2_long_output", p * 3 + c * 14) :
            tier("tier3_long_input", p * 4 + c * 16)
        "#;

        let tier1 = run(
            expr,
            TokenParams {
                p: 15_000.0,
                c: 100.0,
                ..TokenParams::default()
            },
        );
        assert_eq!(tier1.trace.matched_tier, "tier1_short");
        assert_eq!(tier1.cost, 30_800.0);

        let tier2 = run(
            expr,
            TokenParams {
                p: 15_000.0,
                c: 500.0,
                ..TokenParams::default()
            },
        );
        assert_eq!(tier2.trace.matched_tier, "tier2_long_output");
        assert_eq!(tier2.cost, 52_000.0);

        let tier3 = run(
            expr,
            TokenParams {
                p: 50_000.0,
                c: 100.0,
                ..TokenParams::default()
            },
        );
        assert_eq!(tier3.trace.matched_tier, "tier3_long_input");
        assert_eq!(tier3.cost, 201_600.0);
    }

    #[test]
    fn supports_math_helpers_and_v1_prefix() {
        let output = run(
            "v1:max(p, c) * 0.5 + min(p, c) * 0.1 + abs(-2) + ceil(1.2) + floor(1.8)",
            TokenParams {
                p: 300.0,
                c: 500.0,
                ..TokenParams::default()
            },
        );

        assert_eq!(output.cost, 285.0);
    }

    #[test]
    fn probes_request_json_and_headers() {
        let request = RequestInput::from_json_body(json!({
            "service_tier": "fast",
            "stream_options": {
                "fast_mode": true
            },
            "messages": [1, 2, 3, 4]
        }))
        .with_headers(HashMap::from([(
            "Anthropic-Beta".to_string(),
            "fast-mode-2026-02-01".to_string(),
        )]));

        let output = run_billing_expr_with_request(
            r#"
                p
                * (param("service_tier") == "fast" ? 2 : 1)
                * (param("stream_options.fast_mode") == true ? 1.5 : 1)
                * (param("messages.#") > 3 ? 1.2 : 1)
                * (has(header("anthropic-beta"), "fast-mode") ? 2.5 : 1)
            "#,
            TokenParams {
                p: 100.0,
                ..TokenParams::default()
            },
            request,
        )
        .expect("expression should run");

        assert_eq!(output.cost, 900.0);
    }

    #[test]
    fn applies_request_rule_multiplier_after_separator() {
        let expr = r#"
            tier("base", p * 2 + c * 10)
            |||
            (param("service_tier") == "fast" ? 3 : 1)
        "#;
        let params = TokenParams {
            p: 100.0,
            c: 10.0,
            ..TokenParams::default()
        };

        let fast = run_billing_expr_with_request(
            expr,
            params,
            RequestInput::from_json_body(json!({"service_tier": "fast"})),
        )
        .expect("expression should run");
        assert_eq!(fast.cost, 900.0);
        assert_eq!(fast.trace.matched_tier, "base");
        assert_eq!(fast.trace.cost, 300.0);

        let normal = run_billing_expr_with_request(
            expr,
            params,
            RequestInput::from_json_body(json!({"service_tier": "normal"})),
        )
        .expect("expression should run");
        assert_eq!(normal.cost, 300.0);
        assert_eq!(normal.trace.matched_tier, "base");
    }

    #[test]
    fn validates_expression_and_request_rule_without_running_branches() {
        validate_billing_expr(
            r#"tier("base", p * 2 + c * 10)|||(param("service_tier") == "fast" ? 3 : 1)"#,
        )
        .expect("expression should validate");

        let inactive_branch_error = validate_billing_expr("true ? p : missing_var")
            .expect_err("unknown vars should fail validation");
        assert!(inactive_branch_error
            .to_string()
            .contains("unknown identifier"));

        let rule_error =
            validate_billing_expr(r#"tier("base", p)|||(unknown_rule(header("x")) ? 2 : 1)"#)
                .expect_err("unknown request-rule functions should fail validation");
        assert!(rule_error.to_string().contains("unknown function"));

        let arg_error = validate_billing_expr(r#"tier("base", p, c)"#)
            .expect_err("bad function arity should fail validation");
        assert!(arg_error.to_string().contains("expects 2 argument"));
    }

    #[test]
    fn missing_param_returns_nil() {
        let output = run_billing_expr_with_request(
            r#"param("missing.value") == nil ? 2 : 1"#,
            TokenParams::default(),
            RequestInput::from_json_body(json!({"service_tier": "standard"})),
        )
        .expect("expression should run");

        assert_eq!(output.cost, 2.0);
    }

    #[test]
    fn supports_time_helpers_with_utc_fallback() {
        let output = run(
            r#"
                tier("default", p)
                * (hour("UTC") >= 0 ? 1 : 999)
                * (minute("UTC") >= 0 ? 1 : 999)
                * (weekday("UTC") >= 0 && weekday("UTC") <= 6 ? 1 : 999)
                * (month("Asia/Shanghai") >= 1 ? 1 : 999)
                * (day("Invalid/Zone") >= 1 ? 1 : 999)
            "#,
            TokenParams {
                p: 500.0,
                ..TokenParams::default()
            },
        );

        assert_eq!(output.cost, 500.0);
        assert_eq!(output.trace.matched_tier, "default");
    }

    #[test]
    fn supports_multimodal_variables() {
        let output = run(
            r#"tier("base", p * 2 + c * 10 + img * 5 + img_o * 20 + ai * 50 + ao * 100)"#,
            TokenParams {
                p: 1_000.0,
                c: 500.0,
                img: 200.0,
                img_o: 50.0,
                ai: 100.0,
                ao: 25.0,
                ..TokenParams::default()
            },
        );

        assert_eq!(output.cost, 16_500.0);
        assert_eq!(output.trace.matched_tier, "base");
    }

    #[test]
    fn reports_invalid_syntax() {
        let error = run_billing_expr("invalid +-+ syntax", TokenParams::default())
            .expect_err("invalid expression should fail");

        assert!(matches!(error, BillingExprError::Runtime(_)));
    }

    // --- Deterministic time-helper tests (injectable clock). These pin a known
    // UTC instant so the time functions resolve to exact values — the golden
    // vectors Go could not write because it reads the wall clock.

    /// 2024-01-15T13:30:00Z. Fields: weekday=1 (Monday), month=1, day=15,
    /// hour=13, minute=30. Asia/Shanghai (+8) hour=21.
    const PINNED_NOW: i64 = 1_705_325_400;

    #[test]
    fn pinned_utc_fields_resolve_exactly() {
        // hour/minute/weekday/month/day all resolve to the known UTC values.
        let hour = run_billing_expr_at(r#"hour("UTC")"#, TokenParams::default(), PINNED_NOW)
            .unwrap()
            .cost;
        assert_eq!(hour, 13.0);
        let minute = run_billing_expr_at(r#"minute("UTC")"#, TokenParams::default(), PINNED_NOW)
            .unwrap()
            .cost;
        assert_eq!(minute, 30.0);
        let weekday = run_billing_expr_at(r#"weekday("UTC")"#, TokenParams::default(), PINNED_NOW)
            .unwrap()
            .cost;
        assert_eq!(weekday, 1.0); // Monday
        let month = run_billing_expr_at(r#"month("UTC")"#, TokenParams::default(), PINNED_NOW)
            .unwrap()
            .cost;
        assert_eq!(month, 1.0);
        let day = run_billing_expr_at(r#"day("UTC")"#, TokenParams::default(), PINNED_NOW)
            .unwrap()
            .cost;
        assert_eq!(day, 15.0);
    }

    #[test]
    fn asia_shanghai_offset_is_plus_eight() {
        // 13:30 UTC -> 21:30 Asia/Shanghai (+8). Confirms the tz offset path.
        let hour = run_billing_expr_at(
            r#"hour("Asia/Shanghai")"#,
            TokenParams::default(),
            PINNED_NOW,
        )
        .unwrap()
        .cost;
        assert_eq!(hour, 21.0);
    }

    #[test]
    fn night_discount_resolves_to_one_value_not_two() {
        // Go's equivalent test accepts 7000 OR 3500 (non-deterministic). With a
        // pinned clock we get exactly one. At 13:30 UTC the night window
        // (>=21 || <6) is FALSE, so the multiplier is 1 -> cost 7000.
        let cost = run_billing_expr_at(
            r#"tier("default", p * 2 + c * 10) * (hour("UTC") >= 21 || hour("UTC") < 6 ? 0.5 : 1)"#,
            TokenParams {
                p: 1000.0,
                c: 500.0,
                ..TokenParams::default()
            },
            PINNED_NOW,
        )
        .unwrap()
        .cost;
        assert_eq!(cost, 7000.0);

        // Same expression at 22:00 UTC (night) -> multiplier 0.5 -> 3500.
        let night = PINNED_NOW - (13 * 3600 + 30 * 60) + (22 * 3600); // 2024-01-15 22:00:00Z
        let cost = run_billing_expr_at(
            r#"tier("default", p * 2 + c * 10) * (hour("UTC") >= 21 || hour("UTC") < 6 ? 0.5 : 1)"#,
            TokenParams {
                p: 1000.0,
                c: 500.0,
                ..TokenParams::default()
            },
            night,
        )
        .unwrap()
        .cost;
        assert_eq!(cost, 3500.0);
    }

    #[test]
    fn month_day_pattern_resolves_deterministically() {
        // Jan-1 discount. At 2024-01-15 it does NOT apply (multiplier 1).
        let cost = run_billing_expr_at(
            r#"tier("default", p) * (month("Asia/Shanghai") == 1 && day("Asia/Shanghai") == 1 ? 0.5 : 1)"#,
            TokenParams {
                p: 1000.0,
                ..TokenParams::default()
            },
            PINNED_NOW,
        )
        .unwrap()
        .cost;
        assert_eq!(cost, 1000.0);

        // 2024-01-01 00:30 UTC -> 08:30 Shanghai, still Jan 1 -> discount applies.
        let jan1 = 1_704_067_800_i64; // 2024-01-01T00:30:00Z
        let cost = run_billing_expr_at(
            r#"tier("default", p) * (month("Asia/Shanghai") == 1 && day("Asia/Shanghai") == 1 ? 0.5 : 1)"#,
            TokenParams {
                p: 1000.0,
                ..TokenParams::default()
            },
            jan1,
        )
        .unwrap()
        .cost;
        assert_eq!(cost, 500.0);
    }
}
